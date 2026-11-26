import { describe, it, expect } from 'vitest'
import {
  runClientCreditCreate, runClientCreditUpdate, runClientCreditPost, runClientCreditVoid,
  runClientReleaseCreate, runClientReleaseUpdate, runClientReleasePost, runClientReleaseVoid,
  runClientReceiptPost, runClientReceiptVoid,
  clientFinanceCallError, ClientFinanceUncertainError, CLIENT_FINANCE_CALL_TIMEOUT_MS, VOID_REASON_MAX,
  CLIENT_RECEIPT_OVER_ALLOCATION_PREFIX, clientReceiptOverAllocationMessage, APP_CHECK_REFUSED_TEXT,
} from '../../src/lib/clientLedgerActions'
import * as actions from '../../src/lib/clientLedgerActions'
import { gstForLine, invoiceTotals } from '../../src/lib/clientInvoices'
import { CLIENT_ENTRY_STALE_TEXT } from '../../src/lib/clientCreditNotes'
import {
  CLIENT_ENTRY_SHAPES, CLIENT_CREDIT_LINE_KEYS, CLIENT_ENTRY_LIMITS, clientEntryDraftProblem,
} from '../../src/lib/clientEntryShape'
import { describeWriteError, WRITE_FAILURE, WRITE_MESSAGES } from '../../src/lib/writeOutcome'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// ── Client credit notes and retention releases — the browser's writes ────────
// (the trusted transaction boundary of ADR-89)
//
// The write functions take the SDK and the callable as arguments, so they run
// here against a small IN-MEMORY FAKE: a Map of path → data, refs as
// { id, path }, a runTransaction that stages writes and applies them
// ATOMICALLY, and a recording stand-in for the four callables. No Firebase, no
// emulator.
//
// ⚠️ This proves what the BROWSER writes, sends and reports. It proves nothing
// about the trusted backend (tests/functions/clientFinance.test.js) or about
// Firestore Rules (tests/rules/), which are the trust boundary.
//
// The load-bearing properties:
//   1. THE BROWSER WRITES DRAFTS ONLY: create, edit, and the void of a draft.
//      No path here writes a ledger, and none writes `posted`.
//   2. POSTING, AND THE VOID OF A POSTED ENTRY, ARE ONE CALL to the trusted
//      callable, carrying identifiers and a reason — never an amount.
//   3. EVERY TYPED SERVER REFUSAL REACHES THE DIALOG AS ITS OWN TEXT, and the
//      figures-changed refusal as exactly CLIENT_ENTRY_STALE_TEXT.
//   4. AN OUTCOME THE SERVER DID NOT STATE STAYS UNCERTAIN.

// ── The fake ─────────────────────────────────────────────────────────────────

const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)))

function fakeFirestore(seed = {}) {
  const store = new Map(Object.entries(seed).map(([path, data]) => [path, clone(data)]))
  const stats = { attempts: 0, commits: 0 }

  const ref = (path) => ({ id: path.split('/').pop(), path })

  const snapshotOf = (r) => {
    const data = store.get(r.path)
    return { id: r.id, exists: () => data !== undefined, data: () => clone(data) }
  }

  async function runTransaction(_db, fn) {
    stats.attempts += 1
    const writes = []
    const tx = {
      async get(r) {
        // The real SDK refuses a read after a write in the same transaction.
        if (writes.length > 0) throw new Error('Transactions require all reads to be executed before all writes.')
        return snapshotOf(r)
      },
      set(r, data, options) { writes.push({ kind: options?.merge ? 'merge' : 'set', r, data: clone(data) }); return tx },
      update(r, data) { writes.push({ kind: 'update', r, data: clone(data) }); return tx },
    }
    const result = await fn(tx) // a throw here leaves the store untouched

    const next = new Map(store)
    for (const w of writes) {
      const current = next.get(w.r.path)
      if (w.kind === 'update') {
        if (current === undefined) throw new Error(`No document to update: ${w.r.path}`)
        next.set(w.r.path, { ...current, ...w.data })
      } else if (w.kind === 'merge') {
        next.set(w.r.path, { ...(current ?? {}), ...w.data })
      } else {
        next.set(w.r.path, w.data)
      }
    }
    store.clear()
    for (const [path, data] of next) store.set(path, data)
    stats.commits += 1
    return result
  }

  return {
    ref, runTransaction, stats,
    read: (path) => clone(store.get(path)),
    has: (path) => store.has(path),
    // A stable serialisation of the whole store, for "nothing was written".
    dump: () => JSON.stringify([...store.entries()].sort(([a], [b]) => a.localeCompare(b))),
  }
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const P = 'companies/co1/projects/p1'
const PATH = {
  project:        P,
  invoice:        `${P}/clientInvoices/inv1`,
  ledger:         `${P}/clientInvoiceLedgers/inv1`,
  creditCounter:  `${P}/counters/clientCreditNotes`,
  releaseCounter: `${P}/counters/clientRetentionReleases`,
  credit:         (id) => `${P}/clientCreditNotes/${id}`,
  release:        (id) => `${P}/clientRetentionReleases/${id}`,
}

const TS = 'SERVER_TIMESTAMP'

// The stored invoice (no `id` field — it comes from the snapshot):
//   lines 1000.00 gst + 40.15 gst + 300.00 gst_free
//   subtotal 1340.15 · GST 104.02 · gross 1444.17
//   retention 134.02 · retention GST 104.02 × 134.02 ÷ 1340.15 = 10.4025 → 10.40
const lines = () => [
  { description: 'Contract works', amount: 1000, taxCode: 'gst', gstAmount: gstForLine(1000, 'gst'),
    variationId: null, variationNumber: '', costCodeId: null, costCodeName: null },
  { description: 'Variation works', amount: 40.15, taxCode: 'gst', gstAmount: gstForLine(40.15, 'gst'),
    variationId: 'v1', variationNumber: 'CV-0001', costCodeId: 'cc1', costCodeName: '03-100 — Concrete' },
  { description: 'GST-free supply', amount: 300, taxCode: 'gst_free', gstAmount: 0,
    variationId: null, variationNumber: '', costCodeId: null, costCodeName: null },
]

const invoiceData = (retention = 134.02, over = {}, lineItems = lines()) => ({
  invoiceNumber: 'CI-0001', status: 'issued',
  clientId: 'client1', clientName: 'Acme Developments', currency: 'AUD',
  invoiceDate: '2026-10-01', dueDate: '2026-10-31',
  lineItems, ...invoiceTotals(lineItems, retention), ...over,
})

// One project with one issued invoice, a recording callable, and bound action
// helpers. `server(name, data)` decides what the callable does; by default it
// answers as the real one does for a success.
function setup({ invoice = invoiceData(), seed = {}, server = null } = {}) {
  const fs = fakeFirestore({
    [PATH.project]: { name: 'Tower', currency: 'AUD', currencyLocked: false },
    ...(invoice ? { [PATH.invoice]: invoice } : {}),
    ...seed,
  })
  const sdk = (uid) => ({ db: { fake: true }, runTransaction: fs.runTransaction, serverTimestamp: () => TS, uid })
  const target = { invoiceRef: fs.ref(PATH.invoice), ledgerRef: fs.ref(PATH.ledger) }

  const calls = []
  const call = async (name, data) => {
    calls.push({ name, data: clone(data) })
    if (server) return server(name, data)
    return { status: name.startsWith('post') ? 'posted' : 'void', ...data, seq: 1, alreadyApplied: false }
  }

  // The project currency ratchet: reads inside the transaction, stages a write.
  const lock = { staged: 0 }
  const stageCurrencyLock = async (tx) => {
    const snap = await tx.get(fs.ref(PATH.project))
    return () => {
      lock.staged += 1
      if (!snap.data().currencyLocked) tx.update(fs.ref(PATH.project), { currencyLocked: true })
    }
  }

  const creditInput = (rows, over = {}) => ({
    creditDate: '2026-11-01', reason: '  Over-billed  ', clientCreditReference: ' REF-9 ', notes: '', rows, ...over,
  })
  const releaseInput = (amount, over = {}) => ({
    releaseDate: '2026-11-15', reason: ' Practical completion ', notes: ' note ', amount, ...over,
  })

  return {
    fs, lock, calls,
    ledger: () => fs.read(PATH.ledger),
    credit: (id) => fs.read(PATH.credit(id)),
    release: (id) => fs.read(PATH.release(id)),
    // What the trusted backend would have done to an entry — written straight
    // into the store, because no function under test can.
    mark: (path, fields) => fs.runTransaction(null, async (tx) => { tx.update(fs.ref(path), fields) }),
    createCredit: (id, rows, { uid = 'u1', ...over } = {}) => runClientCreditCreate({
      ...sdk(uid), currency: 'AUD', counterRef: fs.ref(PATH.creditCounter), creditRef: fs.ref(PATH.credit(id)),
      ...target, stageCurrencyLock, input: creditInput(rows, over),
    }),
    updateCredit: (id, rows, { uid = 'u1', ...over } = {}) => runClientCreditUpdate({
      ...sdk(uid), creditRef: fs.ref(PATH.credit(id)), ...target, input: creditInput(rows, over),
    }),
    postCredit: (id) => runClientCreditPost({ call, projectId: 'p1', creditNoteId: id }),
    voidCredit: (id, reason = 'Raised in error', uid = 'u1') =>
      runClientCreditVoid({ ...sdk(uid), creditRef: fs.ref(PATH.credit(id)), reason, call, projectId: 'p1' }),
    createRelease: (id, amount, { uid = 'u1', ...over } = {}) => runClientReleaseCreate({
      ...sdk(uid), currency: 'AUD', counterRef: fs.ref(PATH.releaseCounter), releaseRef: fs.ref(PATH.release(id)),
      ...target, stageCurrencyLock, input: releaseInput(amount, over),
    }),
    updateRelease: (id, amount, { uid = 'u1', ...over } = {}) => runClientReleaseUpdate({
      ...sdk(uid), releaseRef: fs.ref(PATH.release(id)), ...target, input: releaseInput(amount, over),
    }),
    postRelease: (id) => runClientReleasePost({ call, projectId: 'p1', releaseId: id }),
    voidRelease: (id, { reason = 'Agreed in error', uid = 'u1', ...extra } = {}) =>
      runClientReleaseVoid({ ...sdk(uid), releaseRef: fs.ref(PATH.release(id)), reason, call, projectId: 'p1', ...extra }),
  }
}

// Asserts the call rejects with `message` and that the store is unchanged
// (the read-only transaction that finds an entry posted commits nothing).
async function expectUnchanged(h, call, message) {
  const before = h.fs.dump()
  await expect(call()).rejects.toThrow(message)
  expect(h.fs.dump()).toBe(before)
}

// Asserts the call rejects with `message` and that NOTHING was written.
async function expectRefused(h, call, message) {
  const before = h.fs.dump()
  const commits = h.fs.stats.commits
  await expect(call()).rejects.toThrow(message)
  expect(h.fs.dump()).toBe(before)
  expect(h.fs.stats.commits).toBe(commits)
}

// A callable failure as the Functions SDK throws it.
const serverError = (code, detailsCode = null, details = {}) => Object.assign(new Error(`sdk text for ${code}`), {
  name: 'FirebaseError', code: `functions/${code}`, ...(detailsCode ? { details: { code: detailsCode, ...details } } : {}),
})

const ROWS = [{ invoiceLineIndex: 0, amount: 200 }, { invoiceLineIndex: 1, amount: 20.07 }]

// ── The fake itself ──────────────────────────────────────────────────────────

describe('the in-memory fake', () => {
  it('applies a transaction\'s writes together, and none when the callback throws', async () => {
    const fs = fakeFirestore({ 'a/1': { n: 1 } })
    await fs.runTransaction(null, async (tx) => {
      const snap = await tx.get(fs.ref('a/1'))
      tx.update(fs.ref('a/1'), { n: snap.data().n + 1 })
      tx.set(fs.ref('a/2'), { n: 10 })
      tx.set(fs.ref('a/3'), { next: 2 }, { merge: true })
    })
    expect([fs.read('a/1'), fs.read('a/2'), fs.read('a/3')]).toEqual([{ n: 2 }, { n: 10 }, { next: 2 }])

    const before = fs.dump()
    await expect(fs.runTransaction(null, async (tx) => {
      tx.set(fs.ref('a/4'), { n: 4 })
      tx.update(fs.ref('a/1'), { n: 99 })
      throw new Error('refused')
    })).rejects.toThrow('refused')
    expect(fs.dump()).toBe(before)
    expect(fs.has('a/4')).toBe(false)
  })

  it('snapshots are copies, and a missing document does not exist', async () => {
    const fs = fakeFirestore({ 'a/1': { nested: { n: 1 } } })
    await fs.runTransaction(null, async (tx) => {
      const snap = await tx.get(fs.ref('a/1'))
      snap.data().nested.n = 99
      expect((await tx.get(fs.ref('a/1'))).data().nested.n).toBe(1)
      const missing = await tx.get(fs.ref('a/none'))
      expect(missing.exists()).toBe(false)
      expect(missing.id).toBe('none')
    })
  })
})

// ── Drafts ───────────────────────────────────────────────────────────────────

describe('credit note: create', () => {
  it('stores a DRAFT built from the invoice, numbers it, and writes no ledger', async () => {
    const h = setup()
    const id = await h.createCredit('cnA', ROWS)
    expect(id).toBe('cnA')
    expect(h.credit('cnA')).toEqual({
      creditNumber: 'CCN-0001', status: 'draft', docType: 'credit_note',
      clientInvoiceId: 'inv1', invoiceNumber: 'CI-0001', clientId: 'client1', clientName: 'Acme Developments',
      creditDate: '2026-11-01', reason: 'Over-billed', clientCreditReference: 'REF-9', notes: '',
      lineItems: [
        { invoiceLineIndex: 0, description: 'Contract works', amount: 200, taxCode: 'gst', gstAmount: 20,
          variationId: null, variationNumber: '', costCodeId: null, costCodeName: null },
        { invoiceLineIndex: 1, description: 'Variation works', amount: 20.07, taxCode: 'gst', gstAmount: 2.01,
          variationId: 'v1', variationNumber: 'CV-0001', costCodeId: 'cc1', costCodeName: '03-100 — Concrete' },
      ],
      subtotal: 220.07, gstTotal: 22.01, grossTotal: 242.08,
      // retention: 134.02 held × 220.07 ÷ 1340.15 still billed = 22.008 → 22.01
      // its GST: held after = (104.02 − 22.01 GST still billed) × 112.01 ÷ 1120.08 = 8.20,
      //          so 10.40 − 8.20 = 2.20 leaves the retained slice
      retentionAmount: 22.01, retentionGst: 2.2, retentionTotal: 24.21, receivableTotal: 217.87,
      ledgerSeq: 0,
      currency: 'AUD', revision: 1,
      postedAt: null, postedBy: null, voidedAt: null, voidedBy: null, voidReason: '',
      createdAt: TS, createdBy: 'u1', updatedAt: TS, updatedBy: 'u1',
    })
    expect(h.fs.read(PATH.creditCounter)).toEqual({ next: 2 })
    expect(h.fs.has(PATH.ledger)).toBe(false)
    // The currency ratchet was staged and committed in the SAME transaction.
    expect(h.lock.staged).toBe(1)
    expect(h.fs.read(PATH.project).currencyLocked).toBe(true)
    expect(h.fs.stats.commits).toBe(1)
  })

  it('numbers consecutive credit notes from the counter', async () => {
    const h = setup()
    await h.createCredit('cnA', ROWS)
    await h.createCredit('cnB', [{ invoiceLineIndex: 2, amount: 50 }])
    expect(h.credit('cnB').creditNumber).toBe('CCN-0002')
    expect(h.fs.read(PATH.creditCounter)).toEqual({ next: 3 })
    // Both drafts were computed against the same untouched ledger.
    expect([h.credit('cnA').ledgerSeq, h.credit('cnB').ledgerSeq]).toEqual([0, 0])
  })

  it('takes the currency from the invoice, falling back to the project currency', async () => {
    const h = setup({ invoice: invoiceData(0, { currency: 'NZD' }) })
    await h.createCredit('cnA', ROWS)
    expect(h.credit('cnA').currency).toBe('NZD')
  })

  it('refuses an invalid draft and writes nothing — not even the counter or the currency lock', async () => {
    const h = setup()
    await expectRefused(h, () => h.createCredit('cnA', [{ invoiceLineIndex: 0, amount: 1000.01 }]),
      'Line 1: only 1000.00 of 1000.00 remains to credit.')
    await expectRefused(h, () => h.createCredit('cnA', []), 'Add at least one line with an amount.')
    await expectRefused(h, () => h.createCredit('cnA', ROWS, { reason: '   ' }),
      'Enter the reason this credit is being issued.')
    await expectRefused(h, () => h.createCredit('cnA', ROWS, { creditDate: '' }), 'Enter the credit note date.')
    expect(h.fs.has(PATH.creditCounter)).toBe(false)
    expect(h.fs.read(PATH.project).currencyLocked).toBe(false)
    expect(h.lock.staged).toBe(0)
  })

  it('refuses a missing, draft or void invoice', async () => {
    await expectRefused(setup({ invoice: null }), function call() { return setup({ invoice: null }).createCredit('cnA', ROWS) },
      'The client invoice could not be found on this project.')
    const draft = setup({ invoice: invoiceData(0, { status: 'draft' }) })
    await expectRefused(draft, () => draft.createCredit('cnA', ROWS),
      'CI-0001 is draft — only an issued client invoice can be credited.')
    const voided = setup({ invoice: invoiceData(0, { status: 'void' }) })
    await expectRefused(voided, () => voided.createCredit('cnA', ROWS),
      'CI-0001 is void — only an issued client invoice can be credited.')
  })
})

describe('retention release: create', () => {
  it('stores a DRAFT with its GST from the invoice, on its own counter', async () => {
    const h = setup()
    const id = await h.createRelease('rrA', 50)
    expect(id).toBe('rrA')
    expect(h.release('rrA')).toEqual({
      releaseNumber: 'CRR-0001', status: 'draft', docType: 'client_retention_release',
      clientInvoiceId: 'inv1', invoiceNumber: 'CI-0001', clientId: 'client1', clientName: 'Acme Developments',
      releaseDate: '2026-11-15', reason: 'Practical completion', notes: 'note',
      // 10.40 × 50.00 ÷ 134.02 = 3.880 → 3.88
      amount: 50, gstAmount: 3.88, releaseTotal: 53.88, ledgerSeq: 0,
      currency: 'AUD', revision: 1,
      postedAt: null, postedBy: null, voidedAt: null, voidedBy: null, voidReason: '',
      createdAt: TS, createdBy: 'u1', updatedAt: TS, updatedBy: 'u1',
    })
    expect(h.fs.read(PATH.releaseCounter)).toEqual({ next: 2 })
    expect(h.fs.has(PATH.creditCounter)).toBe(false)
    expect(h.fs.has(PATH.ledger)).toBe(false)
    expect(h.fs.read(PATH.project).currencyLocked).toBe(true)
  })

  it('refuses an invalid draft and writes nothing', async () => {
    const h = setup()
    await expectRefused(h, () => h.createRelease('rrA', 134.03), 'Only 134.02 of retention (ex-GST) is still held on CI-0001.')
    await expectRefused(h, () => h.createRelease('rrA', 0), 'The release amount must be greater than zero.')
    await expectRefused(h, () => h.createRelease('rrA', 'abc'), 'Enter the release amount (ex-GST) as a number.')
    await expectRefused(h, () => h.createRelease('rrA', 10, { reason: '' }), 'Enter a reason for releasing this retention.')
    await expectRefused(h, () => h.createRelease('rrA', 10, { releaseDate: 'soon' }), 'Enter the date this release was agreed.')
    expect(h.fs.has(PATH.releaseCounter)).toBe(false)
    expect(h.fs.read(PATH.project).currencyLocked).toBe(false)

    const none = setup({ invoice: invoiceData(0) })
    await expectRefused(none, () => none.createRelease('rrA', 10), 'CI-0001 withheld no retention.')
    const missing = setup({ invoice: null })
    await expectRefused(missing, () => missing.createRelease('rrA', 10), 'The client invoice could not be found on this project.')
    const voided = setup({ invoice: invoiceData(134.02, { status: 'void' }) })
    await expectRefused(voided, () => voided.createRelease('rrA', 10),
      'CI-0001 is void — retention can only be released on an issued client invoice.')
  })
})

describe('credit note: edit and void of a DRAFT (client transactions)', () => {
  it('re-saving a draft rebuilds it against the CURRENT ledger and keeps its identity', async () => {
    const h = setup()
    await h.createCredit('cnB', [{ invoiceLineIndex: 0, amount: 100 }])
    expect(h.credit('cnB')).toMatchObject({ ledgerSeq: 0, retentionAmount: 10 })
    // The trusted backend has since posted a release against the invoice.
    const ledger = { seq: 1, lines: {}, lastEntryId: 'rrA', lastEntryKind: 'release',
      creditedSubtotalCents: 0, creditedGstCents: 0, creditedRetentionCents: 0, creditedRetentionGstCents: 0,
      releasedRetentionCents: 6701, releasedRetentionGstCents: 520 }
    const h2 = setup({ seed: { [PATH.credit('cnB')]: h.credit('cnB'), [PATH.ledger]: ledger } })
    await h2.updateCredit('cnB', [{ invoiceLineIndex: 0, amount: 100 }], { uid: 'editor', reason: 'Refreshed' })
    expect(h2.credit('cnB')).toMatchObject({
      status: 'draft', ledgerSeq: 1, reason: 'Refreshed', updatedBy: 'editor',
      // Half the retention is no longer held, so the credit takes half as much of it.
      retentionAmount: 5,
      // Identity and creation stamps are not rewritten by an edit.
      creditNumber: 'CCN-0001', createdBy: 'u1', clientInvoiceId: 'inv1',
    })
    // An edit never writes the ledger.
    expect(h2.ledger()).toEqual(ledger)
    expect(h2.calls).toEqual([])
  })

  it('only a draft can be edited', async () => {
    const h = setup()
    await h.createCredit('cnA', ROWS)
    await h.mark(PATH.credit('cnA'), { status: 'posted' })
    await expectRefused(h, () => h.updateCredit('cnA', ROWS), 'Only a draft credit note can be edited.')
    await expectRefused(h, () => h.updateCredit('nope', ROWS), 'Credit note not found.')
    await h.createCredit('cnB', [{ invoiceLineIndex: 2, amount: 10 }])
    await expectRefused(h, () => h.updateCredit('cnB', [{ invoiceLineIndex: 0, amount: 1000.01 }]),
      'Line 1: only 1000.00 of 1000.00 remains to credit.')
  })

  it('voiding a DRAFT is a direct client write: no call, no ledger', async () => {
    const h = setup()
    await h.createCredit('cnA', ROWS)
    const out = await h.voidCredit('cnA', '  Raised in error  ', 'voider')
    expect(out).toEqual({ status: 'void', creditNoteId: 'cnA' })
    expect(h.calls).toEqual([])
    expect(h.fs.has(PATH.ledger)).toBe(false)
    expect(h.credit('cnA')).toMatchObject({
      status: 'void', voidedAt: TS, voidedBy: 'voider', voidReason: 'Raised in error', postedAt: null, updatedBy: 'voider',
    })
  })

  it('refuses a void with no reason, an over-long reason, of a void credit and of a missing credit — before any call', async () => {
    const h = setup()
    await h.createCredit('cnA', ROWS)
    const attempts = h.fs.stats.attempts
    await expectRefused(h, () => h.voidCredit('cnA', '   '), 'Enter a reason for voiding this credit note.')
    await expectRefused(h, () => h.voidCredit('cnA', 'x'.repeat(VOID_REASON_MAX + 1)), 'The reason cannot be longer than 500 characters.')
    expect(h.fs.stats.attempts).toBe(attempts) // refused before any transaction
    await expectRefused(h, () => h.voidCredit('nope'), 'Credit note not found.')
    await h.voidCredit('cnA')
    await expectRefused(h, () => h.voidCredit('cnA'), 'This credit note is already void.')
    expect(h.calls).toEqual([])
  })
})

describe('retention release: edit and void of a DRAFT (client transactions)', () => {
  it('re-saving a draft rebuilds its GST and keeps its identity; only a draft can be edited', async () => {
    const h = setup()
    await h.createRelease('rrA', 50)
    await h.updateRelease('rrA', 134.02, { uid: 'editor' })
    expect(h.release('rrA')).toMatchObject({
      status: 'draft', amount: 134.02, gstAmount: 10.4, releaseTotal: 144.42, ledgerSeq: 0,
      releaseNumber: 'CRR-0001', createdBy: 'u1', updatedBy: 'editor',
    })
    await h.mark(PATH.release('rrA'), { status: 'posted' })
    await expectRefused(h, () => h.updateRelease('rrA', 10), 'Only a draft retention release can be edited.')
    await expectRefused(h, () => h.updateRelease('nope', 10), 'Retention release not found.')
    expect(h.fs.has(PATH.ledger)).toBe(false)
  })

  it('voiding a DRAFT release is a direct client write and needs no receipt figure', async () => {
    const h = setup()
    await h.createRelease('rrA', 50)
    expect(await h.voidRelease('rrA')).toEqual({ status: 'void', releaseId: 'rrA' })
    expect(h.calls).toEqual([])
    expect(h.fs.has(PATH.ledger)).toBe(false)
    expect(h.release('rrA')).toMatchObject({ status: 'void', voidedBy: 'u1', voidReason: 'Agreed in error' })
  })

  it('refuses a void with no reason, of a void or missing release', async () => {
    const h = setup()
    await h.createRelease('rrA', 50)
    await expectRefused(h, () => h.voidRelease('rrA', { reason: '' }), 'Enter a reason for voiding this retention release.')
    await expectRefused(h, () => h.voidRelease('nope'), 'Retention release not found.')
    await h.voidRelease('rrA')
    await expectRefused(h, () => h.voidRelease('rrA'), 'This retention release is already void.')
  })
})

// ── The stored shape ─────────────────────────────────────────────────────────

describe('a draft is exactly the shape the trusted backend requires (lib/clientEntryShape.js)', () => {
  const stored = (data) => ({ id: 'x', ...data })
  const invoice = () => ({ id: 'inv1', ...invoiceData() })

  it('a created and a re-saved credit note carry exactly the listed keys, and pass the server\'s own check', async () => {
    const h = setup()
    await h.createCredit('cnA', ROWS)
    expect(Object.keys(h.credit('cnA')).sort()).toEqual([...CLIENT_ENTRY_SHAPES.creditNote.keys].sort())
    for (const li of h.credit('cnA').lineItems) expect(Object.keys(li).sort()).toEqual([...CLIENT_CREDIT_LINE_KEYS].sort())
    expect(clientEntryDraftProblem(CLIENT_ENTRY_SHAPES.creditNote, stored(h.credit('cnA')), invoice())).toBeNull()
    await h.updateCredit('cnA', ROWS, { notes: 'again' })
    expect(Object.keys(h.credit('cnA')).sort()).toEqual([...CLIENT_ENTRY_SHAPES.creditNote.keys].sort())
    expect(clientEntryDraftProblem(CLIENT_ENTRY_SHAPES.creditNote, stored(h.credit('cnA')), invoice())).toBeNull()
  })

  it('a created and a re-saved release carry exactly the listed keys, and pass the server\'s own check', async () => {
    const h = setup()
    await h.createRelease('rrA', 50)
    await h.updateRelease('rrA', 60)
    expect(Object.keys(h.release('rrA')).sort()).toEqual([...CLIENT_ENTRY_SHAPES.retentionRelease.keys].sort())
    expect(clientEntryDraftProblem(CLIENT_ENTRY_SHAPES.retentionRelease, stored(h.release('rrA')), invoice())).toBeNull()
  })

  it('the check names the first field that is not as the app writes it', async () => {
    const h = setup()
    await h.createCredit('cnA', ROWS)
    const good = stored(h.credit('cnA'))
    const problem = (over, drop = []) => clientEntryDraftProblem(CLIENT_ENTRY_SHAPES.creditNote,
      Object.fromEntries(Object.entries({ ...good, ...over }).filter(([k]) => !drop.includes(k))), invoice())
    expect(problem({ approved: true })).toBe('approved')
    expect(problem({}, ['notes'])).toBe('notes')
    expect(problem({ status: 'posted' })).toBe('status')
    expect(problem({ docType: 'invoice' })).toBe('docType')
    for (const n of ['CCN-1', 'CRR-0001', 'CCN-0001 ', 7]) expect(problem({ creditNumber: n })).toBe('creditNumber')
    for (const d of ['1 Nov 2026', '2026-11-1', '', null]) expect(problem({ creditDate: d })).toBe('creditDate')
    for (const r of ['', '   ', 'x'.repeat(1001), 5]) expect(problem({ reason: r })).toBe('reason')
    expect(problem({ notes: 5 })).toBe('notes')
    expect(problem({ notes: 'x'.repeat(CLIENT_ENTRY_LIMITS.NOTES + 1) })).toBe('notes')
    expect(problem({ clientCreditReference: 'x'.repeat(CLIENT_ENTRY_LIMITS.REFERENCE + 1) })).toBe('clientCreditReference')
    expect(problem({ revision: '1' })).toBe('revision')
    expect(problem({ ledgerSeq: -1 })).toBe('ledgerSeq')
    expect(problem({ postedBy: 'someone' })).toBe('postedBy')
    expect(problem({ postedAt: TS })).toBe('postedAt')
    expect(problem({ voidedBy: 'someone' })).toBe('voidedBy')
    expect(problem({ voidReason: 'pre-set' })).toBe('voidReason')
    expect(problem({ invoiceNumber: 'CI-9999' })).toBe('invoiceNumber')
    expect(problem({ clientName: 'Somebody Else' })).toBe('clientName')
    expect(problem({ clientId: 'client2' })).toBe('clientId')
    expect(problem({ clientInvoiceId: 'inv2' })).toBe('clientInvoiceId')
    expect(problem({ currency: 'NZD' })).toBe('currency')
    expect(problem({ lineItems: [] })).toBe('lineItems')
    expect(problem({ lineItems: Array.from({ length: 101 }, () => good.lineItems[0]) })).toBe('lineItems')
    expect(problem({ lineItems: [good.lineItems[0], { ...good.lineItems[1], markup: 1 }] })).toBe('lineItems[1]')
    expect(problem({ lineItems: [Object.fromEntries(Object.entries(good.lineItems[0]).filter(([k]) => k !== 'costCodeId'))] })).toBe('lineItems[0]')
    expect(problem({ lineItems: [null] })).toBe('lineItems[0]')
  })

  it('free text over its bound is refused when the draft is SAVED, not first at posting', async () => {
    const h = setup()
    await expectRefused(h, () => h.createCredit('cnA', ROWS, { notes: 'x'.repeat(CLIENT_ENTRY_LIMITS.NOTES + 1) }),
      'The notes cannot be longer than 5000 characters.')
    await expectRefused(h, () => h.createCredit('cnA', ROWS, { clientCreditReference: 'x'.repeat(501) }),
      'The reference cannot be longer than 500 characters.')
    await expectRefused(h, () => h.createCredit('cnA', ROWS, { reason: 'x'.repeat(1001) }),
      'The reason cannot be longer than 1000 characters.')
    await expectRefused(h, () => h.createRelease('rrA', 10, { notes: 'x'.repeat(5001) }),
      'The notes cannot be longer than 5000 characters.')
    await h.createRelease('rrA', 10)
    await expectRefused(h, () => h.updateRelease('rrA', 10, { reason: 'x'.repeat(1001) }),
      'The reason cannot be longer than 1000 characters.')
  })
})

// ── The trusted callables ────────────────────────────────────────────────────

describe('posting is ONE call to the trusted callable — identifiers only', () => {
  it('a credit note: postClientCreditNote({ projectId, creditNoteId }), no transaction, nothing written here', async () => {
    const h = setup()
    await h.createCredit('cnA', ROWS)
    const before = h.fs.dump()
    const attempts = h.fs.stats.attempts
    const out = await h.postCredit('cnA')
    expect(h.calls).toEqual([{ name: 'postClientCreditNote', data: { projectId: 'p1', creditNoteId: 'cnA' } }])
    expect(out).toMatchObject({ status: 'posted', creditNoteId: 'cnA' })
    // The browser wrote nothing: not the entry, not a ledger.
    expect(h.fs.dump()).toBe(before)
    expect(h.fs.stats.attempts).toBe(attempts)
    expect(h.fs.has(PATH.ledger)).toBe(false)
  })

  it('a retention release: postClientRetentionRelease({ projectId, releaseId })', async () => {
    const h = setup()
    await h.createRelease('rrA', 50)
    const before = h.fs.dump()
    await h.postRelease('rrA')
    expect(h.calls).toEqual([{ name: 'postClientRetentionRelease', data: { projectId: 'p1', releaseId: 'rrA' } }])
    expect(h.fs.dump()).toBe(before)
  })
})

describe('voiding a POSTED entry is ONE call — identifiers and the reason', () => {
  it('a posted credit note: the browser writes nothing and calls voidClientCreditNote', async () => {
    const h = setup()
    await h.createCredit('cnA', ROWS)
    await h.mark(PATH.credit('cnA'), { status: 'posted' })
    const before = h.fs.dump()
    const out = await h.voidCredit('cnA', '  Raised in error  ')
    expect(h.calls).toEqual([{ name: 'voidClientCreditNote', data: { projectId: 'p1', creditNoteId: 'cnA', reason: 'Raised in error' } }])
    expect(out).toMatchObject({ status: 'void', creditNoteId: 'cnA' })
    expect(h.fs.dump()).toBe(before)
    expect(h.credit('cnA').status).toBe('posted')   // only the server changes it
  })

  it('a posted release: receipt figures handed in are NOT sent — the server reads the receipts itself', async () => {
    const h = setup()
    await h.createRelease('rrA', 50)
    await h.mark(PATH.release('rrA'), { status: 'posted' })
    const before = h.fs.dump()
    await h.voidRelease('rrA', { receivedCents: 0, receivableBasisCents: 100_000_000 })
    expect(h.calls).toEqual([{ name: 'voidClientRetentionRelease', data: { projectId: 'p1', releaseId: 'rrA', reason: 'Agreed in error' } }])
    expect(h.fs.dump()).toBe(before)
  })

  it('an entry in a state this build does not know is the server\'s to answer, never voided here', async () => {
    const h = setup()
    await h.createCredit('cnA', ROWS)
    await h.mark(PATH.credit('cnA'), { status: 'superseded' })
    await h.voidCredit('cnA')
    expect(h.calls).toHaveLength(1)
    expect(h.credit('cnA').status).toBe('superseded')
  })
})

describe('what a server refusal looks like to the dialog (lib/writeOutcome.js)', () => {
  const posting = async (error) => {
    const h = setup({ server: async () => { throw error } })
    await h.createCredit('cnA', ROWS)
    const before = h.fs.dump()
    const thrown = await h.postCredit('cnA').then(() => null, e => e)
    expect(h.fs.dump()).toBe(before)
    return thrown
  }

  it('FIGURES CHANGED rejects with a plain Error whose message is exactly CLIENT_ENTRY_STALE_TEXT', async () => {
    const thrown = await posting(serverError('failed-precondition', 'client-entry-figures-changed', { field: 'retentionAmount' }))
    expect(thrown).toBeInstanceOf(Error)
    expect(thrown.name).toBe('Error')
    expect(thrown.message).toBe(CLIENT_ENTRY_STALE_TEXT)
    expect(thrown.code).toBeUndefined()
    expect(thrown.cause).toBeUndefined()
    expect(thrown.serverCode).toBe('client-entry-figures-changed')
    // What the dialog shows — and what its "Refresh figures" offer keys on.
    expect(describeWriteError(thrown)).toEqual({ certain: true, kind: WRITE_FAILURE.LOCAL, message: CLIENT_ENTRY_STALE_TEXT })
    // The same for a release.
    const h = setup({ server: async () => { throw serverError('failed-precondition', 'client-entry-figures-changed', { reason: 'Only 0.00 of retention (ex-GST) is still held on CI-0001.' }) } })
    await h.createRelease('rrA', 50)
    const release = await h.postRelease('rrA').then(() => null, e => e)
    expect(describeWriteError(release).message).toBe(CLIENT_ENTRY_STALE_TEXT)
  })

  // The raw FirebaseError would have been replaced by a generic text.
  it('the unmapped SDK error would NOT have shown that text', () => {
    const raw = serverError('failed-precondition', 'client-entry-figures-changed')
    expect(describeWriteError(raw).message).not.toBe(CLIENT_ENTRY_STALE_TEXT)
  })

  it.each([
    ['unauthenticated', 'unauthenticated', {}, 'Your session has ended. Nothing was changed — sign in again and retry.'],
    ['permission-denied', 'no-membership', {}, 'You do not have permission to do this. Nothing was changed.'],
    ['permission-denied', 'membership-inactive', {}, 'Your membership is no longer active. Nothing was changed.'],
    ['permission-denied', 'client-finance-forbidden', {}, 'Only a Company Admin, Project Manager or QS can post or void this. Nothing was changed.'],
    ['invalid-argument', 'invalid-argument', {}, 'The server rejected this request. Nothing was changed.'],
    ['not-found', 'not-found', {}, 'This project could not be found. Nothing was changed — reload the page.'],
    ['not-found', 'client-entry-not-found', {}, 'This credit note no longer exists. Nothing was changed — reload the page.'],
    ['failed-precondition', 'client-entry-invalid', { field: 'approved' }, 'This credit note is not stored as Constrap writes one (approved), so it cannot be posted or voided. Nothing was changed.'],
    ['failed-precondition', 'client-entry-not-draft', {}, 'This credit note is no longer a draft — it has already been posted or voided. Nothing was changed.'],
    ['failed-precondition', 'client-entry-not-posted', {}, 'This credit note is already void. Nothing was changed.'],
    ['failed-precondition', 'client-invoice-not-issued', {}, 'The client invoice is missing or is no longer issued. Nothing was changed.'],
    ['failed-precondition', 'client-invoice-not-issued', { invoiceNumber: 'CI-0004' }, 'CI-0004 is missing or is no longer issued. Nothing was changed.'],
    ['failed-precondition', 'client-invoice-mismatch', {}, 'The client invoice belongs to a different client or currency than this credit note, or no longer carries that number. Nothing was changed.'],
    ['unavailable', 'client-receipt-disabled', {}, 'Posting and voiding client receipts is temporarily unavailable. Nothing was changed.'],
    ['failed-precondition', 'client-receipt-future-dated', { receiptDate: '2027-01-01' }, 'The receipt date (2027-01-01) is in the future. A receipt records money already received, so it can only be posted on or after that date. Nothing was posted.'],
    ['failed-precondition', 'client-invoice-inconsistent', {}, 'The client invoice stores totals that do not reconcile to its own lines, so nothing can be posted against it. Nothing was changed.'],
    ['failed-precondition', 'client-ledger-invariant', { invariant: 'Credits exceed the invoice subtotal.' }, 'Credits exceed the invoice subtotal. This credit note cannot be posted.'],
    // `unavailable` and `aborted` are transport statuses writeOutcome would call
    // uncertain or generic — a TYPED refusal is neither: nothing was written.
    ['unavailable', 'client-finance-disabled', {}, 'Posting and voiding credit notes and retention releases is temporarily unavailable. Nothing was changed.'],
    ['aborted', 'client-finance-busy', {}, 'This invoice was being changed at the same moment. Nothing was changed — try again.'],
    // Company activation, the historical receipt baseline and the supported range (ADR-89, final pass).
    ['failed-precondition', 'client-finance-not-activated', {}, 'Client credit notes and retention releases are not yet available for this company. Nothing was changed.'],
    ['failed-precondition', 'client-receipt-baseline-missing', {}, 'The receipt history of this project has not been brought into the invoice ledgers yet, so nothing can be posted or voided. Nothing was changed — try again.'],
    ['failed-precondition', 'client-receipt-baseline-inconsistent', {}, 'The receipt history of this project does not agree with its invoice ledgers, so nothing can be posted or voided until it is reviewed. Nothing was changed — contact support.'],
    ['failed-precondition', 'client-receipt-baseline-inconsistent', { number: 'CR-0004', receiptId: 'x' }, 'The receipt history of this project does not agree with its invoice ledgers (receipt CR-0004), so nothing can be posted or voided until it is reviewed. Nothing was changed — contact support.'],
    ['failed-precondition', 'client-receipt-baseline-invalid', { number: 'CR-0002', field: 'allocations[0].allocatedAmount' }, 'Receipt CR-0002, posted earlier on this project, is not stored as Constrap writes one (allocations[0].allocatedAmount), so the receipt history cannot be brought into the invoice ledgers. Nothing was changed — contact support.'],
    ['failed-precondition', 'client-receipt-baseline-invalid', {}, 'A receipt, posted earlier on this project, is not stored as Constrap writes one, so the receipt history cannot be brought into the invoice ledgers. Nothing was changed — contact support.'],
    ['failed-precondition', 'client-receipt-baseline-too-large', { invoices: 500 }, 'The earlier receipt history of this project is too large to be brought into the invoice ledgers automatically. Nothing was changed — contact support.'],
    ['failed-precondition', 'client-amount-out-of-range', { field: 'subtotal' }, 'The client invoice is above the largest amount Constrap supports, so nothing can be posted. Nothing was changed.'],
    ['failed-precondition', 'client-amount-out-of-range', { field: 'subtotal', invoiceNumber: 'CI-0009' }, 'CI-0009 is above the largest amount Constrap supports, so nothing can be posted. Nothing was changed.'],
    ['failed-precondition', 'client-amount-out-of-range', { field: 'amount' }, 'This credit note is above the largest amount Constrap supports, so nothing can be posted. Nothing was changed.'],
  ])('%s / %s → a definite failure carrying its own message', async (grpc, code, details, message) => {
    const thrown = await posting(serverError(grpc, code, details))
    expect(thrown.name).toBe('Error')
    expect(thrown.message).toBe(message)
    expect(describeWriteError(thrown)).toEqual({ certain: true, kind: WRITE_FAILURE.LOCAL, message })
  })

  it('void refusals name the remedy: dependent entries, and receipts the SERVER found allocated', async () => {
    const refuse = (error) => setup({ server: async () => { throw error } })
    const a = refuse(serverError('failed-precondition', 'client-ledger-invariant', { invariant: 'Credited GST exceeds the invoice GST.' }))
    await a.createCredit('cnA', ROWS)
    await a.mark(PATH.credit('cnA'), { status: 'posted' })
    await expectUnchanged(a, () => a.voidCredit('cnA'), 'Credited GST exceeds the invoice GST. Void the dependent entries first.')

    const b = refuse(serverError('failed-precondition', 'client-ledger-invariant', { invariant: 'Credits against the receivable part exceed what is receivable.' }))
    await b.createRelease('rrA', 50)
    await b.mark(PATH.release('rrA'), { status: 'posted' })
    await expectUnchanged(b, () => b.voidRelease('rrA'),
      'Credits against the receivable part exceed what is receivable. Void the credit notes posted after this release first.')

    const c = refuse(serverError('failed-precondition', 'client-receipts-depend-on-release', { receivedCents: 5, receivableBasisCents: 1 }))
    await c.createRelease('rrA', 50)
    await c.mark(PATH.release('rrA'), { status: 'posted' })
    const thrown = await c.voidRelease('rrA').then(() => null, e => e)
    expect(thrown.message).toBe('Receipts are already allocated against this released retention, so the server refused to void it. Void or re-allocate those receipts before voiding the release.')
    expect(describeWriteError(thrown).certain).toBe(true)
    expect(c.release('rrA').status).toBe('posted')
  })

  it.each([
    ['deadline-exceeded', 'deadline-exceeded', WRITE_FAILURE.NO_ANSWER, WRITE_MESSAGES.noAnswer],
    ['unavailable', 'unavailable', WRITE_FAILURE.UNREACHABLE, WRITE_MESSAGES.unreachable],
    ['internal', 'unknown', WRITE_FAILURE.NO_ANSWER, WRITE_MESSAGES.noAnswer],
    ['cancelled', 'unknown', WRITE_FAILURE.NO_ANSWER, WRITE_MESSAGES.noAnswer],
    ['data-loss', 'unknown', WRITE_FAILURE.NO_ANSWER, WRITE_MESSAGES.noAnswer],
    // A status with NO typed code is never promoted to a definite refusal.
    ['failed-precondition', 'unknown', WRITE_FAILURE.NO_ANSWER, WRITE_MESSAGES.noAnswer],
    ['aborted', 'unknown', WRITE_FAILURE.NO_ANSWER, WRITE_MESSAGES.noAnswer],
  ])('NO typed answer (%s) stays UNCERTAIN — never "nothing was saved"', async (grpc, code, kind, message) => {
    const thrown = await posting(serverError(grpc))
    expect(thrown).toBeInstanceOf(ClientFinanceUncertainError)
    expect(thrown.code).toBe(code)
    expect(thrown.cause.code).toBe(`functions/${grpc}`)
    expect(describeWriteError(thrown)).toEqual({ certain: false, kind, message })
  })

  it('a non-Firebase failure (a thrown TypeError, a rejected fetch) is uncertain too', async () => {
    const thrown = await posting(new TypeError('Failed to fetch'))
    expect(thrown).toBeInstanceOf(ClientFinanceUncertainError)
    expect(describeWriteError(thrown).certain).toBe(false)
  })

  it('refused before the handler ran: a rejected session or App Check token, and a server without the callable', () => {
    const kind = { noun: 'credit note' }
    expect(clientFinanceCallError(serverError('unauthenticated'), kind, 'post').message).toBe('Your session has ended. Nothing was changed — sign in again and retry.')
    expect(clientFinanceCallError(serverError('permission-denied'), kind, 'post').message).toBe('You do not have permission to do this. Nothing was changed.')
    const missing = clientFinanceCallError(serverError('not-found'), kind, 'post')
    expect(missing.message).toBe('Posting and voiding is not available on this server yet. Nothing was changed.')
    expect(describeWriteError(missing).certain).toBe(true)
  })

  it('the browser waits longer than the callable may run', () => {
    expect(CLIENT_FINANCE_CALL_TIMEOUT_MS).toBe(130000)
    const index = readFileSync(fileURLToPath(new URL('../../functions/src/index.js', import.meta.url)), 'utf8')
    expect(index).toMatch(/CLIENT_FINANCE_CALL_OPTIONS = \{[^}]*timeoutSeconds: 120,/)
  })
})

// ── Receipts ─────────────────────────────────────────────────────────────────

describe('client receipts: posting and the void of a posted receipt are the trusted callables', () => {
  const R = `${P}/clientReceipts/cr1`
  const receiptSetup = (status, server = null) => {
    const h = setup({ seed: { [R]: { receiptNumber: 'CR-0001', status, amount: 500, allocations: [] } }, server })
    const sdk = { db: { fake: true }, runTransaction: h.fs.runTransaction, serverTimestamp: () => TS, uid: 'u1' }
    const call = async (name, data) => { h.calls.push({ name, data: clone(data) }); if (server) return server(name, data); return { status: name.startsWith('post') ? 'posted' : 'void', receiptId: 'cr1' } }
    return {
      ...h,
      post: (extra = {}) => runClientReceiptPost({ call, projectId: 'p1', receiptId: 'cr1', ...extra }),
      void: (reason = 'Keyed twice', extra = {}) => runClientReceiptVoid({ ...sdk, receiptRef: h.fs.ref(R), reason, call, projectId: 'p1', ...extra }),
      receipt: () => h.fs.read(R),
    }
  }

  it('post: ids and the acknowledgement flag (false unless exactly true) — never an amount; nothing written here', async () => {
    const h = receiptSetup('draft')
    const before = h.fs.dump()
    await h.post()
    await h.post({ acknowledgeOverAllocation: true })
    await h.post({ acknowledgeOverAllocation: 'yes' })
    expect(h.calls).toEqual([
      { name: 'postClientReceipt', data: { projectId: 'p1', receiptId: 'cr1', acknowledgeOverAllocation: false } },
      { name: 'postClientReceipt', data: { projectId: 'p1', receiptId: 'cr1', acknowledgeOverAllocation: true } },
      { name: 'postClientReceipt', data: { projectId: 'p1', receiptId: 'cr1', acknowledgeOverAllocation: false } },
    ])
    expect(h.fs.dump()).toBe(before)
    expect(h.fs.stats.attempts).toBe(0)
  })

  it('void: a DRAFT is a direct write; a POSTED receipt is one call and nothing is written here', async () => {
    const draft = receiptSetup('draft')
    expect(await draft.void('  Keyed twice ')).toEqual({ status: 'void', receiptId: 'cr1' })
    expect(draft.calls).toEqual([])
    expect(draft.receipt()).toMatchObject({ status: 'void', voidedBy: 'u1', voidReason: 'Keyed twice', voidedAt: TS })

    const posted = receiptSetup('posted')
    const before = posted.fs.dump()
    await posted.void()
    expect(posted.calls).toEqual([{ name: 'voidClientReceipt', data: { projectId: 'p1', receiptId: 'cr1', reason: 'Keyed twice' } }])
    expect(posted.fs.dump()).toBe(before)

    await expect(posted.void('  ')).rejects.toThrow('Enter a reason for voiding this receipt.')
    const voided = receiptSetup('void')
    await expect(voided.void()).rejects.toThrow('This receipt is already void.')
  })

  it('OVER-ALLOCATION: a plain Error that STARTS with the contract prefix and names each invoice, what remains and the excess', async () => {
    expect(CLIENT_RECEIPT_OVER_ALLOCATION_PREFIX).toBe('The balance of an invoice changed since this receipt was prepared.')
    const invoices = [{ invoiceId: 'i1', invoiceNumber: 'CI-0004', allocatedCents: 990000, remainingCents: 880000, excessCents: 110000 }]
    const h = receiptSetup('draft', async () => { throw serverError('failed-precondition', 'client-receipt-over-allocated', { invoices }) })
    const thrown = await h.post().then(() => null, e => e)
    expect(thrown.name).toBe('Error')
    expect(thrown.code).toBeUndefined()
    expect(thrown.serverCode).toBe('client-receipt-over-allocated')
    expect(thrown.message.startsWith(CLIENT_RECEIPT_OVER_ALLOCATION_PREFIX)).toBe(true)
    expect(thrown.message).toBe(
      'The balance of an invoice changed since this receipt was prepared. CI-0004 has 8800.00 remaining and this receipt allocates 1100.00 more than that. '
      + 'Nothing was posted. Review the allocations, or tick the over-allocation acknowledgement to post anyway.')
    expect(describeWriteError(thrown)).toEqual({ certain: true, kind: WRITE_FAILURE.LOCAL, message: thrown.message })
  })

  it('the over-allocation message: two decimals always, up to three invoices then "and N more", and the prefix even with no detail', () => {
    const inv = (n, remaining, excess) => ({ invoiceNumber: n, remainingCents: remaining, excessCents: excess })
    expect(clientReceiptOverAllocationMessage([inv('CI-0001', 0, 5), inv('CI-0002', 1050, 100000)])).toBe(
      `${CLIENT_RECEIPT_OVER_ALLOCATION_PREFIX} CI-0001 has 0.00 remaining and this receipt allocates 0.05 more than that and `
      + 'CI-0002 has 10.50 remaining and this receipt allocates 1000.00 more than that. '
      + 'Nothing was posted. Review the allocations, or tick the over-allocation acknowledgement to post anyway.')
    const five = clientReceiptOverAllocationMessage([1, 2, 3, 4, 5].map(n => inv(`CI-000${n}`, 100, 100)))
    expect(five).toContain('CI-0003 has 1.00 remaining and this receipt allocates 1.00 more than that and 2 more.')
    expect(five).not.toContain('CI-0004')
    for (const none of [undefined, null, [], 'x']) {
      expect(clientReceiptOverAllocationMessage(none)).toBe(`${CLIENT_RECEIPT_OVER_ALLOCATION_PREFIX} Nothing was posted. Review the allocations, or tick the over-allocation acknowledgement to post anyway.`)
    }
    expect(clientReceiptOverAllocationMessage([inv('', 100, 100)])).toContain('An invoice has 1.00 remaining')
  })
})

// ── Refusals that name what blocks them ──────────────────────────────────────

describe('a refused void names the documents that block it', () => {
  const kind = { noun: 'credit note', dependents: 'Void the dependent entries first.' }
  const release = { noun: 'retention release', dependents: 'Void the credit notes posted after this release first.' }
  const invariant = (details) => clientFinanceCallError(serverError('failed-precondition', 'client-ledger-invariant', { invariant: 'Credits against the receivable part exceed what is receivable.', ...details }), kind, 'void').message
  const depend = (details) => clientFinanceCallError(serverError('failed-precondition', 'client-receipts-depend-on-release', details), release, 'void').message
  const entry = (number, k = 'retention_release') => ({ kind: k, number, id: number, postedAt: '2026-11-26T00:00:00.000Z' })
  const receipt = (number, allocatedCents) => ({ number, id: number, allocatedCents })

  it('one later entry', () => {
    expect(invariant({ number: 'CCN-0002', blockingEntries: [entry('CRR-0003')] }))
      .toBe('CCN-0002 cannot be voided while CRR-0003, posted after it, still stands. Void CRR-0003 first.')
  })
  it('several: two, three, and more than three', () => {
    expect(invariant({ number: 'CRR-0001', blockingEntries: [entry('CCN-0005', 'credit_note'), entry('CCN-0004', 'credit_note')] }))
      .toBe('CRR-0001 cannot be voided while CCN-0005 and CCN-0004, posted after it, still stand. Void CCN-0005 and CCN-0004 first.')
    expect(invariant({ number: 'CRR-0001', blockingEntries: ['A', 'B', 'C'].map(n => entry(n)) }))
      .toBe('CRR-0001 cannot be voided while A, B and C, posted after it, still stand. Void A, B and C first.')
    expect(invariant({ number: 'CRR-0001', blockingEntries: ['A', 'B', 'C', 'D', 'E'].map(n => entry(n)) }))
      .toBe('CRR-0001 cannot be voided while A, B, C and 2 more, posted after it, still stand. Void A, B, C and 2 more first.')
  })
  it('FALL-BACK: no blocker identified → the invariant and the generic remedy', () => {
    const generic = 'Credits against the receivable part exceed what is receivable. Void the dependent entries first.'
    expect(invariant({})).toBe(generic)
    expect(invariant({ number: 'CCN-0002', blockingEntries: [] })).toBe(generic)
    expect(invariant({ number: 'CCN-0002', blockingEntries: [{ id: 'x' }] })).toBe(generic)   // no number to name
  })
  it('an invariant refusal of a POSTING never claims a later entry blocks it', () => {
    expect(clientFinanceCallError(serverError('failed-precondition', 'client-ledger-invariant', { invariant: 'Credits exceed the invoice subtotal.', blockingEntries: [entry('X')] }), kind, 'post').message)
      .toBe('Credits exceed the invoice subtotal. This credit note cannot be posted.')
  })
  it('one receipt: its number and what it allocated', () => {
    expect(depend({ number: 'CRR-0001', receivedCents: 5298, receivableBasisAfterCents: 0, blockingReceipts: [receipt('CR-0007', 5298)] }))
      .toBe('CRR-0001 cannot be voided: receipt CR-0007 has allocated 52.98 to this invoice, more than the 0.00 it would be owed without this release. Void or re-allocate CR-0007 first.')
  })
  it('several receipts: named up to three, with the total received and what the invoice would be owed', () => {
    expect(depend({ number: 'CRR-0001', receivedCents: 990000, receivableBasisAfterCents: 891000, blockingReceipts: [receipt('CR-0009', 500000), receipt('CR-0008', 490000)] }))
      .toBe('CRR-0001 cannot be voided: receipts CR-0009 and CR-0008 have allocated 9900.00 to this invoice, more than the 8910.00 it would be owed without this release. Void or re-allocate them first.')
    expect(depend({ number: 'CRR-0001', receivedCents: 400, receivableBasisAfterCents: 0, blockingReceipts: [1, 2, 3, 4].map(n => receipt(`CR-000${n}`, 100)) }))
      .toContain('receipts CR-0001, CR-0002, CR-0003 and 1 more have allocated 4.00 to this invoice')
  })
  it('HISTORY: receipts recorded before posting moved to the server cannot be listed — the message says so and never implies the list is complete', () => {
    const at = '2026-12-01T03:04:05.000Z'
    // Nothing could be listed: the whole figure is historical.
    expect(depend({ number: 'CRR-0001', receivedCents: 990000, receivableBasisAfterCents: 891000, blockingReceipts: [], unlistedReceivedCents: 990000, receiptBaselineAt: at }))
      .toBe('CRR-0001 cannot be voided: Receipts recorded before 2026-12-01 have allocated 9900.00 to this invoice, more than the 8910.00 it would be owed without this release. Void or re-allocate receipts on this invoice first — check the receipts list for every receipt allocated to it.')
    // One listed receipt explains part of it.
    expect(depend({ number: 'CRR-0001', receivedCents: 990000, receivableBasisAfterCents: 891000, blockingReceipts: [receipt('CR-0007', 100000)], unlistedReceivedCents: 890000, receiptBaselineAt: at }))
      .toBe('CRR-0001 cannot be voided: receipt CR-0007 and receipts recorded before 2026-12-01 have together allocated 9900.00 to this invoice, more than the 8910.00 it would be owed without this release. Void or re-allocate receipts on this invoice first — check the receipts list for every receipt allocated to it.')
    expect(depend({ number: 'CRR-0001', receivedCents: 990000, receivableBasisAfterCents: 891000, blockingReceipts: [receipt('CR-0007', 1), receipt('CR-0008', 1)], unlistedReceivedCents: 989998, receiptBaselineAt: at }))
      .toContain('receipts CR-0007 and CR-0008 and receipts recorded before 2026-12-01 have together allocated 9900.00')
    // Unexplained with no historical baseline on the invoice (the lookup is capped): still honest, no date invented.
    expect(depend({ number: 'CRR-0001', receivedCents: 500, receivableBasisAfterCents: 0, blockingReceipts: [receipt('CR-0007', 100)], unlistedReceivedCents: 400, receiptBaselineAt: null }))
      .toBe('CRR-0001 cannot be voided: receipt CR-0007 and other receipts not listed here have together allocated 5.00 to this invoice, more than the 0.00 it would be owed without this release. Void or re-allocate receipts on this invoice first — check the receipts list for every receipt allocated to it.')
    expect(depend({ receivedCents: 500, receivableBasisAfterCents: 0, unlistedReceivedCents: 500 }))
      .toContain('This retention release cannot be voided: Other receipts not listed here have allocated 5.00')
    // A complete list is worded exactly as before.
    expect(depend({ number: 'CRR-0001', receivedCents: 5298, receivableBasisAfterCents: 0, blockingReceipts: [receipt('CR-0007', 5298)], unlistedReceivedCents: 0 }))
      .toBe('CRR-0001 cannot be voided: receipt CR-0007 has allocated 52.98 to this invoice, more than the 0.00 it would be owed without this release. Void or re-allocate CR-0007 first.')
  })
  it('FALL-BACK: no receipt identified → the generic wording, which says the SERVER refused', () => {
    const generic = 'Receipts are already allocated against this released retention, so the server refused to void it. Void or re-allocate those receipts before voiding the release.'
    expect(depend({ receivedCents: 5, receivableBasisAfterCents: 1 })).toBe(generic)
    expect(depend({ number: 'CRR-0001', blockingReceipts: [] })).toBe(generic)
  })
  it('each is a definite failure carrying its own text', () => {
    const err = clientFinanceCallError(serverError('failed-precondition', 'client-receipts-depend-on-release', { number: 'CRR-0001', blockingReceipts: [receipt('CR-0007', 5298)] }), release, 'void')
    expect(describeWriteError(err)).toEqual({ certain: true, kind: WRITE_FAILURE.LOCAL, message: err.message })
  })
})

// ── App Check versus an ended session (tracker D3 #38) ───────────────────────

describe('an untyped `unauthenticated` from a callable', () => {
  const kind = { noun: 'receipt' }
  it('with a user still signed in it was App Check — a definite failure saying so', () => {
    const err = clientFinanceCallError(serverError('unauthenticated'), kind, 'post', () => true)
    expect(err.message).toBe('The server could not verify this app (App Check), so the request was refused. Nothing was changed — reload the page and try again.')
    expect(err.message).toBe(APP_CHECK_REFUSED_TEXT)
    expect(describeWriteError(err)).toEqual({ certain: true, kind: WRITE_FAILURE.LOCAL, message: APP_CHECK_REFUSED_TEXT })
  })
  it('with no user signed in, the session has ended', () => {
    const err = clientFinanceCallError(serverError('unauthenticated'), kind, 'post', () => false)
    expect(err.message).toBe('Your session has ended. Nothing was changed — sign in again and retry.')
    expect(describeWriteError(err).certain).toBe(true)
    // No probe supplied: the conservative reading.
    expect(clientFinanceCallError(serverError('unauthenticated'), kind, 'post').message).toBe(err.message)
  })
  it('a TYPED unauthenticated is the handler\'s own answer: the session, whatever the probe says', () => {
    expect(clientFinanceCallError(serverError('unauthenticated', 'unauthenticated'), kind, 'post', () => true).message)
      .toBe('Your session has ended. Nothing was changed — sign in again and retry.')
  })
  it('every action passes the probe through: post and posted-void, all three kinds', async () => {
    const refuse = async () => { throw serverError('unauthenticated') }
    const isSignedIn = () => true
    const h = setup({ server: refuse })
    await h.createCredit('cnA', ROWS)
    await h.mark(PATH.credit('cnA'), { status: 'posted' })
    await h.createRelease('rrA', 50)
    await h.mark(PATH.release('rrA'), { status: 'posted' })
    const sdk = { db: {}, runTransaction: h.fs.runTransaction, serverTimestamp: () => TS, uid: 'u1' }
    const runs = [
      () => runClientCreditPost({ call: refuse, projectId: 'p1', creditNoteId: 'cnA', isSignedIn }),
      () => runClientReleasePost({ call: refuse, projectId: 'p1', releaseId: 'rrA', isSignedIn }),
      () => runClientReceiptPost({ call: refuse, projectId: 'p1', receiptId: 'cr1', isSignedIn }),
      () => runClientCreditVoid({ ...sdk, creditRef: h.fs.ref(PATH.credit('cnA')), reason: 'x', call: refuse, projectId: 'p1', isSignedIn }),
      () => runClientReleaseVoid({ ...sdk, releaseRef: h.fs.ref(PATH.release('rrA')), reason: 'x', call: refuse, projectId: 'p1', isSignedIn }),
    ]
    for (const run of runs) await expect(run()).rejects.toThrow(APP_CHECK_REFUSED_TEXT)
  })
})

// ── The boundary, in source ──────────────────────────────────────────────────

describe('the browser has no path to a ledger or to `posted`', () => {
  const read = (rel) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8')
  const code = (rel) => read(rel).split('\n').filter(l => !l.trim().startsWith('//')).join('\n')

  it('lib/clientLedgerActions.js writes no ledger, applies no ledger movement and never stores `posted`', () => {
    const src = code('src/lib/clientLedgerActions.js')
    expect(src).not.toMatch(/ledgerDocument|applyCredit|applyRelease|ledgerInvariantError|writeLedger/)
    expect(src).not.toMatch(/tx\.(set|update)\(ledgerRef/)
    expect(src).not.toMatch(/status:\s*(CCN_STATUS|CRR_STATUS|kind\.status)\.POSTED/)
    expect(src).not.toMatch(/postedAt:\s*serverTimestamp|postedBy:\s*uid/)
    expect(src).not.toMatch(/from 'firebase/)
    expect(Object.keys(actions).sort()).toEqual([
      'APP_CHECK_REFUSED_TEXT', 'CLIENT_FINANCE_CALL_TIMEOUT_MS', 'CLIENT_RECEIPT_OVER_ALLOCATION_PREFIX', 'ClientFinanceUncertainError', 'VOID_REASON_MAX',
      'clientFinanceCallError', 'clientReceiptOverAllocationMessage',
      'runClientCreditCreate', 'runClientCreditPost', 'runClientCreditUpdate', 'runClientCreditVoid',
      'runClientReceiptPost', 'runClientReceiptVoid',
      'runClientReleaseCreate', 'runClientReleasePost', 'runClientReleaseUpdate', 'runClientReleaseVoid',
    ])
  })

  it('the hooks call the four callables by name, with the long timeout, and keep their public API', () => {
    const credits = code('src/hooks/useClientCreditNotes.jsx')
    const releases = code('src/hooks/useClientRetentionReleases.jsx')
    for (const src of [credits, releases]) {
      expect(src).toContain("import { httpsCallable } from 'firebase/functions'")
      expect(src).toContain('httpsCallable(functions, name, { timeout: CLIENT_FINANCE_CALL_TIMEOUT_MS })(data)).data')
      expect(src).not.toMatch(/setDoc|updateDoc|addDoc|writeBatch/)
    }
    expect(credits).toContain('runClientCreditPost({ call: callClientFinance, isSignedIn, projectId, creditNoteId: creditNote.id })')
    expect(releases).toContain('runClientReleasePost({ call: callClientFinance, isSignedIn, projectId, releaseId: release.id })')
    const receipts = code('src/hooks/useClientReceipts.jsx')
    for (const src of [credits, releases, receipts]) expect(src).toContain('const isSignedIn = () => auth.currentUser != null')
    expect(receipts).toContain('httpsCallable(functions, name, { timeout: CLIENT_FINANCE_CALL_TIMEOUT_MS })(data)).data')
    expect(receipts).toContain('const postClientReceipt = useCallback(async (receipt, { acknowledgeOverAllocation = false } = {}) => {')
    expect(receipts).toMatch(/runClientReceiptPost\(\{\s*call: callClientFinance, isSignedIn, projectId, receiptId: receipt\.id, acknowledgeOverAllocation,\s*\}\)/)
    // The receipts hook no longer writes `posted` or voids a posted receipt itself: its one updateDoc is the draft edit.
    expect(receipts.match(/updateDoc\(/g)).toHaveLength(1)
    expect(receipts).not.toMatch(/status:\s*PAYMENT_STATUS\.(POSTED|VOID)/)
    expect(receipts.match(/runTransaction\(db/g)).toHaveLength(1)
    expect(credits).toMatch(/createClientCreditNote, updateClientCreditNote, postClientCreditNote, voidClientCreditNote,\s*\}/)
    expect(releases).toMatch(/createClientRetentionRelease, updateClientRetentionRelease,\s*postClientRetentionRelease, voidClientRetentionRelease,\s*\}/)
    // No receipt figure travels from the page to the write.
    expect(releases).not.toMatch(/receivedCents|receivableBasisCents|\.\.\.balance/)
    const actionsSrc = read('src/lib/clientLedgerActions.js')
    for (const name of ['postClientCreditNote', 'voidClientCreditNote', 'postClientRetentionRelease', 'voidClientRetentionRelease', 'postClientReceipt', 'voidClientReceipt']) {
      expect(actionsSrc).toContain(`'${name}'`)
      expect(read('functions/src/index.js')).toMatch(new RegExp(`^export const ${name}\\s+= clientFinanceCall\\('${name}'\\)$`, 'm'))
    }
  })
})
