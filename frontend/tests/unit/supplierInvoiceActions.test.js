import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  runCreateSupplierInvoice, runCancelSupplierInvoice, runLinkExistingInvoice,
  buildSupplierInvoiceDocument, claimLinkUpdate, claimUnlinkUpdate, claimPairingError, existingInvoiceLinkError,
  claimLinkReconciliation, CLAIM_LINK_ISSUE, CLAIM_LINK_ISSUE_LABELS, SI_ACTIVE_STATUSES,
  SupplierInvoiceWriteError, SI_WRITE_ERROR, SI_WRITE_ERROR_MESSAGES, supplierInvoiceWriteErrorKind,
} from '../../src/lib/supplierInvoiceActions'
import {
  CLAIM_INVOICE_LINK, CLAIM_LINK_INITIAL, claimInvoiceLink, isClaimInvoiceable, CLAIM_STATUS,
} from '../../src/lib/progressClaims'
import { transitionUpdate } from '../../src/lib/progressClaimActions'
import { SI_STATUS, SI_SOURCE, invoiceTotals, invoicedClaimIds, claimHasActiveInvoice } from '../../src/lib/supplierInvoices'
import { remainingCommitment } from '../../src/lib/commitment'
import { actualClaimsByCostCode } from '../../src/lib/progressClaims'

// ── SHIELD 2A (ADR-68) — claim ↔ invoice pairing over a FAKE transaction ─────
//
// The emulator suite (tests/rules/claimInvoicePairing.rules.test.js) runs the
// real transactions against the real rules. This file pins the module's
// contract without Firestore: the exact writes, the order of the checks, the
// outcome kinds (SUCCESS / ALREADY_INVOICED / LEGACY_UNRECONCILED / STALE /
// MISSING / INVALID / PERMISSION / OFFLINE / UNKNOWN), the link-state
// classification, and that the link is workflow state no figure reads.

const NOW = Symbol('serverTimestamp()')
const serverTimestamp = () => NOW
const read = (rel) => readFileSync(fileURLToPath(new URL(`../../src/${rel}`, import.meta.url)), 'utf8')

// Refs are either plain ids or `{ id }` objects (a DocumentReference stand-in:
// the module reads `invoiceRef.id`, as the SDK's does).
const key = (ref) => (typeof ref === 'string' ? ref : ref.id)
function fakeDb(docs, { lockLocked = true } = {}) {
  const writes = []
  const reads = []
  const tx = {
    get: async (ref) => { reads.push(key(ref)); return { exists: () => docs[key(ref)] !== undefined, id: key(ref), data: () => docs[key(ref)] } },
    set: (ref, data, opts) => writes.push({ op: 'set', ref: key(ref), data, opts }),
    update: (ref, data) => writes.push({ op: 'update', ref: key(ref), data }),
  }
  const runTransaction = async (_db, body) => body(tx)
  const stageLock = async (t) => {
    await t.get('project')
    return lockLocked ? () => {} : () => t.update('project', { currencyLocked: true })
  }
  return { runTransaction, writes, reads, stageLock }
}

const CLAIM_LINES = [{ poLineIndex: 0, costCodeId: 'c', costCodeName: 'C', description: 'Slab', poLineTotal: 800, previouslyApproved: 0, claimedToDate: 300, claimedThisPeriod: 300, approvedThisPeriod: 300 }]
const approvedClaim = (over = {}) => ({
  id: 'cl1', claimNumber: 'PC-0001', status: CLAIM_STATUS.APPROVED, poId: 'po', poNumber: 'PO-0001',
  supplierId: 'sup1', supplierName: 'Ace Concrete', revision: 2, lineItems: CLAIM_LINES,
  retention: 0, approvedSubtotal: 300, approvedGst: 30, approvedTotal: 330,
  ...CLAIM_LINK_INITIAL, ...over,
})
const INV_LINES = [{ poLineIndex: 0, costCodeId: 'c', costCodeName: 'C', description: 'Slab', amount: 300, taxCode: 'gst', gstAmount: 30 }]
const document = (over = {}) => ({
  source: SI_SOURCE.PROGRESS_CLAIM, supplierId: 'sup1', supplierName: 'Ace Concrete', poId: 'po', poNumber: 'PO-0001',
  progressClaimId: 'cl1', claimNumber: 'PC-0001', variationLineCount: 0,
  supplierInvoiceNumber: ' A-1 ', invoiceDate: '2026-11-03', receivedDate: '', dueDate: '', paymentTerms: null,
  lineItems: INV_LINES, retention: 0, currency: 'AUD', notes: ' n ', ...over,
})
const refs = { counterRef: 'counter', invoiceRef: { id: 'si_new', path: 'invoices/si_new' }, claimRef: 'cl1' }
const create = (fake, over = {}) => runCreateSupplierInvoice({
  db: {}, refs, document: document(), seenClaim: approvedClaim(), uid: 'u_qs',
  runTransaction: fake.runTransaction, serverTimestamp, stageLock: fake.stageLock, formatNumber: (n) => `SI-${String(n).padStart(4, '0')}`,
  ...over,
})

async function expectKind(promise, kind) {
  let caught
  try { await promise } catch (e) { caught = e }
  expect(caught).toBeInstanceOf(SupplierInvoiceWriteError)
  expect(caught.kind).toBe(kind)
  return caught
}

// ── Link state ───────────────────────────────────────────────────────────────

describe('claimInvoiceLink — the key’s PRESENCE is the legacy discriminator', () => {
  it('absent key → LEGACY; present null → UNLINKED; non-empty string → LINKED; anything else → MALFORMED', () => {
    expect(claimInvoiceLink({ status: 'approved' })).toEqual({ state: CLAIM_INVOICE_LINK.LEGACY, invoiceId: null })
    expect(claimInvoiceLink({ supplierInvoiceId: null })).toEqual({ state: CLAIM_INVOICE_LINK.UNLINKED, invoiceId: null })
    expect(claimInvoiceLink({ supplierInvoiceId: 'si1' })).toEqual({ state: CLAIM_INVOICE_LINK.LINKED, invoiceId: 'si1' })
    for (const bad of ['', 0, 42, true, {}, []]) expect(claimInvoiceLink({ supplierInvoiceId: bad }).state).toBe(CLAIM_INVOICE_LINK.MALFORMED)
    expect(claimInvoiceLink({ supplierInvoiceId: undefined }).state).toBe(CLAIM_INVOICE_LINK.MALFORMED)
    expect(claimInvoiceLink(null).state).toBe(CLAIM_INVOICE_LINK.LEGACY)
  })

  it('isClaimInvoiceable — approved AND new-format AND unlinked, nothing else', () => {
    expect(isClaimInvoiceable(approvedClaim())).toBe(true)
    expect(isClaimInvoiceable(approvedClaim({ supplierInvoiceId: 'si1' }))).toBe(false)
    const { supplierInvoiceId: _l, ...legacy } = approvedClaim()   // eslint-disable-line no-unused-vars
    expect(isClaimInvoiceable(legacy)).toBe(false)
    expect(isClaimInvoiceable(approvedClaim({ status: 'submitted' }))).toBe(false)
    expect(isClaimInvoiceable(approvedClaim({ supplierInvoiceId: 7 }))).toBe(false)
  })

  it('the new bundle initialises the three keys null at create and at approve', () => {
    expect(CLAIM_LINK_INITIAL).toEqual({ supplierInvoiceId: null, supplierInvoiceLinkedAt: null, supplierInvoiceLinkedBy: null })
    expect(Object.isFrozen(CLAIM_LINK_INITIAL)).toBe(true)
    const hook = read('hooks/useProgressClaims.jsx')
    expect(hook).toContain('...CLAIM_LINK_INITIAL,')
    const live = { ...approvedClaim({ status: 'submitted', approvedSubtotal: null, approvedGst: null, approvedTotal: null, revision: 1 }) }
    delete live.supplierInvoiceId; delete live.supplierInvoiceLinkedAt; delete live.supplierInvoiceLinkedBy
    const approve = transitionUpdate(live, CLAIM_STATUS.APPROVED, { approvedAmounts: [300] }, 'u_pm', NOW)
    expect(approve).toMatchObject(CLAIM_LINK_INITIAL)
    // Approval still certifies exactly the same figures — the link is not money.
    expect(approve).toMatchObject({ approvedSubtotal: 300, approvedGst: 30, approvedTotal: 330 })
  })
})

// ── The documents ────────────────────────────────────────────────────────────

describe('the writes — document, link, unlink', () => {
  it('buildSupplierInvoiceDocument is the ADR-40 shape: born draft, stamps null, audit stamps on, paidAt deprecated null', () => {
    const totals = invoiceTotals(INV_LINES, 0)
    const d = buildSupplierInvoiceDocument({ ...document(), invoiceNumber: 'SI-0001', totals, uid: 'u_qs', now: NOW })
    expect(Object.keys(d).sort()).toEqual([
      'invoiceNumber', 'supplierInvoiceNumber', 'status', 'docType', 'source', 'supplierId', 'supplierName', 'poId', 'poNumber',
      'progressClaimId', 'claimNumber', 'variationLineCount', 'invoiceDate', 'receivedDate', 'dueDate', 'paymentTerms', 'lineItems',
      'retention', 'retentionGst', 'retentionTotal', 'subtotal', 'gstTotal', 'grossTotal', 'net', 'payableGst', 'payableTotal',
      'currency', 'revision', 'notes', 'approvedAt', 'approvedBy', 'postedAt', 'postedBy', 'cancelledAt', 'cancelledBy',
      'paidAt', 'adjustsInvoiceId', 'attachments', 'externalRefs', 'createdAt', 'createdBy', 'updatedAt', 'updatedBy',
    ].sort())
    expect(d).toMatchObject({
      invoiceNumber: 'SI-0001', supplierInvoiceNumber: 'A-1', status: 'draft', docType: 'invoice', source: 'progress_claim',
      progressClaimId: 'cl1', claimNumber: 'PC-0001', notes: 'n', currency: 'AUD', revision: 1,
      subtotal: 300, gstTotal: 30, grossTotal: 330, payableTotal: 330,
      approvedAt: null, approvedBy: null, postedAt: null, postedBy: null, cancelledAt: null, cancelledBy: null,
      paidAt: null, adjustsInvoiceId: null, attachments: [], externalRefs: {},
      createdAt: NOW, createdBy: 'u_qs', updatedAt: NOW, updatedBy: 'u_qs',
    })
    // The invoice carries NO link key of its own — the link lives on the claim.
    expect('supplierInvoiceId' in d).toBe(false)
  })

  it('claimLinkUpdate / claimUnlinkUpdate carry exactly the link keys, revision + 1 and the audit stamps', () => {
    expect(claimLinkUpdate(approvedClaim(), { invoiceId: 'si_new', uid: 'u_qs', now: NOW })).toEqual({
      supplierInvoiceId: 'si_new', supplierInvoiceLinkedAt: NOW, supplierInvoiceLinkedBy: 'u_qs', revision: 3, updatedAt: NOW, updatedBy: 'u_qs',
    })
    expect(claimUnlinkUpdate(approvedClaim({ supplierInvoiceId: 'si_new', revision: 3 }), { uid: 'u_pm', now: NOW })).toEqual({
      supplierInvoiceId: null, supplierInvoiceLinkedAt: null, supplierInvoiceLinkedBy: null, revision: 4, updatedAt: NOW, updatedBy: 'u_pm',
    })
    // A legacy claim with no revision reads 0, so the link carries 1 — as the rules read it.
    const { revision: _r, ...noRev } = approvedClaim()   // eslint-disable-line no-unused-vars
    expect(claimLinkUpdate(noRev, { invoiceId: 'x', uid: 'u', now: NOW }).revision).toBe(1)
  })
})

// ── Create ───────────────────────────────────────────────────────────────────

describe('runCreateSupplierInvoice — the paired create', () => {
  it('SUCCESS: reads counter, project and claim BEFORE writing counter + invoice + claim link (+ lock); the number is consumed once', async () => {
    const fake = fakeDb({ counter: { next: 7 }, project: { currencyLocked: false }, cl1: approvedClaim() }, { lockLocked: false })
    const out = await create(fake)
    expect(out).toEqual({ kind: null, invoiceId: 'si_new', invoiceNumber: 'SI-0007' })
    expect(fake.reads).toEqual(['counter', 'project', 'cl1'])
    expect(fake.writes.map(w => [w.op, w.ref])).toEqual([
      ['set', 'counter'], ['set', 'si_new'], ['update', 'cl1'], ['update', 'project'],
    ])
    expect(fake.writes[0].data).toEqual({ next: 8 })
    expect(fake.writes[1].data).toMatchObject({ invoiceNumber: 'SI-0007', progressClaimId: 'cl1', status: 'draft', createdAt: NOW })
    expect(fake.writes[2].data).toEqual(claimLinkUpdate(approvedClaim(), { invoiceId: 'si_new', uid: 'u_qs', now: NOW }))
    expect(fake.writes[3].data).toEqual({ currencyLocked: true })
    // Every read precedes every write.
    expect(fake.reads).toHaveLength(3)
  })

  it('a direct_po invoice reads no claim and writes no link; a first invoice starts the counter at 1', async () => {
    const fake = fakeDb({ project: { currencyLocked: true } })
    const out = await create(fake, { document: document({ source: SI_SOURCE.DIRECT_PO, progressClaimId: null, claimNumber: null }), seenClaim: null, refs: { ...refs, claimRef: null } })
    expect(out.invoiceNumber).toBe('SI-0001')
    expect(fake.reads).toEqual(['counter', 'project'])
    expect(fake.writes.map(w => [w.op, w.ref])).toEqual([['set', 'counter'], ['set', 'si_new']])
    expect(fake.writes[1].data.progressClaimId).toBeNull()
  })

  it('a claim-sourced create without the reviewed claim (or its ref) is INVALID before any read', async () => {
    const fake = fakeDb({ cl1: approvedClaim() })
    await expectKind(create(fake, { seenClaim: null }), SI_WRITE_ERROR.INVALID)
    await expectKind(create(fake, { refs: { ...refs, claimRef: null } }), SI_WRITE_ERROR.INVALID)
    await expectKind(create(fake, { uid: null }), SI_WRITE_ERROR.PERMISSION)
    expect(fake.reads).toEqual([])
    expect(fake.writes).toEqual([])
  })

  it('ALREADY_INVOICED: the server claim is already linked — nothing written, no number consumed, the linked invoice id is carried (never "created")', async () => {
    const fake = fakeDb({ counter: { next: 7 }, project: {}, cl1: approvedClaim({ supplierInvoiceId: 'si_other', revision: 3 }) })
    const err = await expectKind(create(fake), SI_WRITE_ERROR.ALREADY_INVOICED)
    expect(err.linkedInvoiceId).toBe('si_other')
    expect(err.message).toMatch(/already has an active supplier invoice/)
    expect(err.message).toMatch(/Nothing was created/)
    expect(fake.writes).toEqual([])
  })

  it('a RETRY after a successful commit (double-click, uncertain network) re-reads the linked claim → ALREADY_INVOICED, never a second invoice', async () => {
    const docs = { counter: { next: 7 }, project: {}, cl1: approvedClaim() }
    const fake = fakeDb(docs)
    await create(fake)
    // Apply the committed writes to the fake store, as Firestore would.
    docs.cl1 = { ...docs.cl1, ...fake.writes[2].data }
    docs.counter = fake.writes[0].data
    const retry = fakeDb(docs)
    const err = await expectKind(create(retry), SI_WRITE_ERROR.ALREADY_INVOICED)
    expect(err.linkedInvoiceId).toBe('si_new')
    expect(retry.writes).toEqual([])
    expect(docs.counter).toEqual({ next: 8 })
  })

  it('LEGACY_UNRECONCILED: a server claim with NO link key fails closed — nothing written', async () => {
    const { supplierInvoiceId: _a, supplierInvoiceLinkedAt: _b, supplierInvoiceLinkedBy: _c, ...legacy } = approvedClaim()   // eslint-disable-line no-unused-vars
    const fake = fakeDb({ counter: { next: 7 }, project: {}, cl1: legacy })
    const err = await expectKind(create(fake), SI_WRITE_ERROR.LEGACY_UNRECONCILED)
    expect(err.message).toMatch(/reconciled on the Progress Claims tab/)
    expect(fake.writes).toEqual([])
  })

  it('STALE: not approved any more, another revision, or certified figures / line count differing from the reviewed copy — nothing written', async () => {
    for (const live of [
      approvedClaim({ status: 'rejected' }),
      approvedClaim({ revision: 5 }),
      approvedClaim({ approvedGst: 31 }),
      approvedClaim({ approvedTotal: 331 }),
      approvedClaim({ lineItems: [...CLAIM_LINES, ...CLAIM_LINES] }),
    ]) {
      const fake = fakeDb({ counter: { next: 7 }, project: {}, cl1: live })
      const err = await expectKind(create(fake), SI_WRITE_ERROR.STALE)
      expect(err.message).toMatch(/Review the latest version/)
      expect(fake.writes).toEqual([])
    }
  })

  it('MISSING: the claim vanished; INVALID: the claim names another PO, supplier or claim number, or the invoice does not reconcile — nothing written', async () => {
    await expectKind(create(fakeDb({ counter: {}, project: {} })), SI_WRITE_ERROR.MISSING)
    for (const [live, pattern] of [
      [approvedClaim({ poId: 'po9', poNumber: 'PO-0009' }), /claim against PO-0009/],
      [approvedClaim({ supplierId: 'sup9' }), /different supplier/],
      [approvedClaim({ supplierName: 'Beta Steel' }), /different supplier/],
      [approvedClaim({ claimNumber: 'PC-0002' }), /not the claim this invoice was built from/],
    ]) {
      const fake = fakeDb({ counter: {}, project: {}, cl1: live })
      const err = await expectKind(create(fake), SI_WRITE_ERROR.INVALID)
      expect(err.message).toMatch(pattern)
      expect(fake.writes).toEqual([])
    }
    // The existing reconciliation guard runs against the SERVER figures.
    const fake = fakeDb({ counter: {}, project: {}, cl1: approvedClaim() })
    const seen = approvedClaim()
    const err = await expectKind(create(fake, { document: document({ lineItems: [{ ...INV_LINES[0], amount: 299, gstAmount: 29.9 }] }), seenClaim: seen }), SI_WRITE_ERROR.INVALID)
    expect(err.message).toMatch(/does not reconcile/)
    expect(fake.writes).toEqual([])
  })

  it('a null supplierId on both sides (pre-Contacts) agrees; a trimmed name agrees', async () => {
    const fake = fakeDb({ counter: {}, project: {}, cl1: approvedClaim({ supplierId: null, supplierName: ' Ace Concrete ' }) })
    await create(fake, { document: document({ supplierId: null }), seenClaim: approvedClaim({ supplierId: null }) })
    expect(fake.writes).toHaveLength(3)
  })

  it('maps a thrown Firestore error to its kind and preserves the cause; the error message table names every outcome', async () => {
    for (const [code, kind] of [['permission-denied', 'permission'], ['unavailable', 'offline'], ['deadline-exceeded', 'offline'], ['not-found', 'missing'], ['aborted', 'unknown'], [undefined, 'unknown']]) {
      expect(supplierInvoiceWriteErrorKind(code)).toBe(kind)
      const runTransaction = async () => { const e = new Error('boom'); e.code = code; throw e }
      const err = await expectKind(create({ runTransaction, stageLock: async () => () => {} }), kind)
      expect(err.cause?.message).toBe('boom')
    }
    expect(Object.keys(SI_WRITE_ERROR_MESSAGES).sort()).toEqual(Object.values(SI_WRITE_ERROR).sort())
    expect(Object.values(SI_WRITE_ERROR)).toEqual(['already_invoiced', 'legacy_unreconciled', 'stale', 'missing', 'invalid', 'permission', 'offline', 'unknown'])
  })

  it('claimPairingError — the order of the checks: missing, status, link state, revision, identity, certified figures', () => {
    const inv = document()
    expect(claimPairingError(null, approvedClaim(), inv).kind).toBe('missing')
    expect(claimPairingError(approvedClaim({ status: 'submitted', supplierInvoiceId: 'x' }), approvedClaim(), inv).kind).toBe('stale')
    expect(claimPairingError(approvedClaim({ supplierInvoiceId: 'x', revision: 9 }), approvedClaim(), inv)).toMatchObject({ kind: 'already_invoiced', linkedInvoiceId: 'x' })
    expect(claimPairingError(approvedClaim({ supplierInvoiceId: 3 }), approvedClaim(), inv).kind).toBe('invalid')
    expect(claimPairingError(approvedClaim({ revision: 9, poId: 'zz' }), approvedClaim(), inv).kind).toBe('stale')
    expect(claimPairingError(approvedClaim({ poId: 'zz' }), approvedClaim(), inv).kind).toBe('invalid')
    expect(claimPairingError(approvedClaim(), approvedClaim(), inv)).toBeNull()
  })
})

// ── Cancel ───────────────────────────────────────────────────────────────────

describe('runCancelSupplierInvoice — the paired cancel', () => {
  const inv = (over = {}) => ({ id: 'si1', invoiceNumber: 'SI-0001', status: SI_STATUS.DRAFT, source: SI_SOURCE.PROGRESS_CLAIM, progressClaimId: 'cl1', ...over })
  const cancel = (fake, over = {}) => runCancelSupplierInvoice({
    db: {}, invoiceRef: { id: 'si1' }, claimRef: 'cl1', seen: inv(), uid: 'u_qs', runTransaction: fake.runTransaction, serverTimestamp, ...over,
  })

  it('a draft or approved claim-sourced invoice its claim links: cancel + unlink in ONE transaction, reads before writes', async () => {
    for (const status of [SI_STATUS.DRAFT, SI_STATUS.APPROVED]) {
      const fake = fakeDb({ si1: inv({ status }), cl1: approvedClaim({ supplierInvoiceId: 'si1', revision: 3 }) })
      const out = await cancel(fake, { seen: inv({ status }) })
      expect(out).toEqual({ kind: null, unlinked: true })
      expect(fake.reads).toEqual(['si1', 'cl1'])
      expect(fake.writes).toEqual([
        { op: 'update', ref: 'si1', data: { status: 'cancelled', cancelledAt: NOW, cancelledBy: 'u_qs', updatedAt: NOW, updatedBy: 'u_qs' } },
        { op: 'update', ref: 'cl1', data: { supplierInvoiceId: null, supplierInvoiceLinkedAt: null, supplierInvoiceLinkedBy: null, revision: 4, updatedAt: NOW, updatedBy: 'u_qs' } },
      ])
    }
  })

  it('an invoice its claim does NOT link (legacy claim, claim linked elsewhere, claim missing, direct PO) cancels alone — no link is invented', async () => {
    const { supplierInvoiceId: _l, ...legacy } = approvedClaim()   // eslint-disable-line no-unused-vars
    for (const docs of [
      { si1: inv(), cl1: legacy },
      { si1: inv(), cl1: approvedClaim({ supplierInvoiceId: 'si_other' }) },
      { si1: inv() },
      { si1: inv({ source: SI_SOURCE.DIRECT_PO, progressClaimId: null }), cl1: approvedClaim({ supplierInvoiceId: 'si1' }) },
    ]) {
      const fake = fakeDb(docs)
      const out = await cancel(fake, { seen: docs.si1 })
      expect(out).toEqual({ kind: null, unlinked: false })
      expect(fake.writes.map(w => w.ref)).toEqual(['si1'])
    }
  })

  it('a posted invoice is terminal: refused before any read, and refused on the server copy; a stale status is STALE; a vanished invoice is MISSING', async () => {
    const fake = fakeDb({ si1: inv({ status: 'posted' }) })
    await expectKind(cancel(fake, { seen: inv({ status: 'posted' }) }), SI_WRITE_ERROR.INVALID)
    expect(fake.reads).toEqual([])
    const err = await expectKind(cancel(fake), SI_WRITE_ERROR.STALE)
    expect(err.message).toMatch(/SI-0001 is now posted, not draft/)
    await expectKind(cancel(fakeDb({})), SI_WRITE_ERROR.MISSING)
    await expectKind(cancel(fake, { uid: null }), SI_WRITE_ERROR.PERMISSION)
    expect(fake.writes).toEqual([])
  })

  it('two concurrent cancellations: the second sees a cancelled copy and writes nothing', async () => {
    const docs = { si1: inv(), cl1: approvedClaim({ supplierInvoiceId: 'si1' }) }
    const first = fakeDb(docs)
    await cancel(first)
    docs.si1 = { ...docs.si1, ...first.writes[0].data }
    docs.cl1 = { ...docs.cl1, ...first.writes[1].data }
    const second = fakeDb(docs)
    await expectKind(cancel(second), SI_WRITE_ERROR.STALE)
    expect(second.writes).toEqual([])
    // The claim is free again for exactly one new invoice.
    expect(isClaimInvoiceable(docs.cl1)).toBe(true)
  })
})

// ── Reconcile an existing invoice ────────────────────────────────────────────

describe('runLinkExistingInvoice — reconcile a claim with no current link to ONE existing active invoice', () => {
  const existing = (over = {}) => ({ id: 'si9', invoiceNumber: 'SI-0009', status: SI_STATUS.POSTED, source: SI_SOURCE.PROGRESS_CLAIM, progressClaimId: 'cl1', poId: 'po', supplierId: 'sup1', ...over })
  const { supplierInvoiceId: _a, supplierInvoiceLinkedAt: _b, supplierInvoiceLinkedBy: _c, ...legacyClaim } = approvedClaim()   // eslint-disable-line no-unused-vars
  const link = (fake, over = {}) => runLinkExistingInvoice({
    db: {}, claimRef: 'cl1', invoiceRef: { id: 'si9' }, seenClaim: legacyClaim, seenInvoice: existing(), uid: 'u_admin',
    runTransaction: fake.runTransaction, serverTimestamp, ...over,
  })

  it('links a LEGACY claim (key absent) and a new-format null claim to an existing draft, approved or posted invoice — the link write only', async () => {
    for (const seenClaim of [legacyClaim, approvedClaim()]) {
      for (const status of SI_ACTIVE_STATUSES) {
        const fake = fakeDb({ cl1: seenClaim, si9: existing({ status }) })
        const out = await link(fake, { seenClaim, seenInvoice: existing({ status }) })
        expect(out).toEqual({ kind: null, invoiceId: 'si9' })
        expect(fake.reads).toEqual(['cl1', 'si9'])
        expect(fake.writes).toEqual([{ op: 'update', ref: 'cl1', data: claimLinkUpdate(seenClaim, { invoiceId: 'si9', uid: 'u_admin', now: NOW }) }])
      }
    }
  })

  it('refuses BEFORE any read: a cancelled invoice (reserves nothing), another claim’s invoice, another PO, another supplier, a direct-PO invoice, a non-approved or already-linked claim', async () => {
    const cases = [
      [{ seenInvoice: existing({ status: 'cancelled' }) }, /reserves nothing/],
      [{ seenInvoice: existing({ progressClaimId: 'cl2' }) }, /does not reference PC-0001/],
      [{ seenInvoice: existing({ poId: 'po2' }) }, /different purchase order/],
      [{ seenInvoice: existing({ supplierId: 'sup2' }) }, /different supplier/],
      [{ seenInvoice: existing({ source: 'direct_po' }) }, /not a claim-sourced invoice/],
      [{ seenClaim: { ...legacyClaim, status: 'submitted' } }, /not approved/],
      [{ seenClaim: approvedClaim({ supplierInvoiceId: 'si1' }) }, /already linked/],
      [{ seenClaim: approvedClaim({ supplierInvoiceId: 5 }) }, /malformed/],
    ]
    for (const [over, pattern] of cases) {
      const fake = fakeDb({ cl1: legacyClaim, si9: existing() })
      const err = await expectKind(link(fake, over), SI_WRITE_ERROR.INVALID)
      expect(err.message).toMatch(pattern)
      expect(fake.reads).toEqual([])
      expect(fake.writes).toEqual([])
    }
  })

  it('on the SERVER copies: a vanished claim or invoice is MISSING, another revision is STALE, a claim linked meanwhile is ALREADY_INVOICED, a changed invoice is INVALID — nothing written', async () => {
    await expectKind(link(fakeDb({ si9: existing() })), SI_WRITE_ERROR.MISSING)
    await expectKind(link(fakeDb({ cl1: legacyClaim })), SI_WRITE_ERROR.MISSING)
    await expectKind(link(fakeDb({ cl1: { ...legacyClaim, revision: 9 }, si9: existing() })), SI_WRITE_ERROR.STALE)
    const linked = await expectKind(link(fakeDb({ cl1: { ...legacyClaim, supplierInvoiceId: 'si1' }, si9: existing() })), SI_WRITE_ERROR.ALREADY_INVOICED)
    expect(linked.linkedInvoiceId).toBe('si1')
    const fake = fakeDb({ cl1: legacyClaim, si9: existing({ status: 'cancelled' }) })
    await expectKind(link(fake), SI_WRITE_ERROR.INVALID)
    expect(fake.writes).toEqual([])
  })

  it('there is NO action that sets an absent link key to null — the module exports no such write and the hook offers none', () => {
    const src = read('lib/supplierInvoiceActions.js')
    expect(src).not.toMatch(/export (async )?function run(ConfirmNoInvoice|MarkUninvoiced|AttestUninvoiced|InitialiseLink)/)
    for (const rel of ['lib/supplierInvoiceActions.js', 'hooks/useProgressClaims.jsx', 'pages/project/ProjectProgressClaims.jsx']) {
      expect(read(rel), rel).not.toMatch(/confirmNoInvoice|markUninvoiced|attestUninvoiced|initialiseLink/)
    }
    // The only claim write that sets the three keys to null is the UNLINK, and it requires a stored string id.
    expect(read('../firestore.rules')).toContain("&& resource.data.get('supplierInvoiceId', null) is string\n                      && linkUnlinked(request.resource.data)")
    // existingInvoiceLinkError is the only eligibility test and it requires an invoice.
    expect(existingInvoiceLinkError(legacyClaim, null)).toMatch(/no longer exists/)
  })
})

// ── Reconciliation classification (the claims tab + SHIELD condition I) ──────

describe('claimLinkReconciliation — what the link says beside the register', () => {
  const { supplierInvoiceId: _a, supplierInvoiceLinkedAt: _b, supplierInvoiceLinkedBy: _c, ...legacy } = approvedClaim()   // eslint-disable-line no-unused-vars
  const ex = (over = {}) => ({ id: 'si9', invoiceNumber: 'SI-0009', status: 'draft', source: 'progress_claim', progressClaimId: 'cl1', poId: 'po', supplierId: 'sup1', ...over })

  it('legacy: no invoice / cancelled only / one active (linkable) / several active (duplicates — blocked)', () => {
    expect(claimLinkReconciliation(legacy, []).issue).toBe(CLAIM_LINK_ISSUE.LEGACY_NO_INVOICE)
    expect(claimLinkReconciliation(legacy, [ex({ status: 'cancelled' })]).issue).toBe(CLAIM_LINK_ISSUE.LEGACY_CANCELLED_ONLY)
    const one = claimLinkReconciliation(legacy, [ex({ status: 'cancelled', id: 'x' }), ex({ status: 'posted' })])
    expect(one.issue).toBe(CLAIM_LINK_ISSUE.UNLINKED_ACTIVE_INVOICE)
    expect(one.linkable.id).toBe('si9')
    const two = claimLinkReconciliation(legacy, [ex(), ex({ id: 'si10' })])
    expect(two.issue).toBe(CLAIM_LINK_ISSUE.UNLINKED_DUPLICATES)
    expect(two.linkable).toBeNull()
    expect(two.activeInvoices).toHaveLength(2)
  })

  it('new-format null: no invoice → no issue (invoiceable); one active → linkable; one active that mismatches → mismatch, not linkable', () => {
    expect(claimLinkReconciliation(approvedClaim(), []).issue).toBeNull()
    expect(claimLinkReconciliation(approvedClaim(), [ex()]).issue).toBe(CLAIM_LINK_ISSUE.UNLINKED_ACTIVE_INVOICE)
    const mismatch = claimLinkReconciliation(approvedClaim(), [ex({ poId: 'po2' })])
    expect(mismatch.issue).toBe(CLAIM_LINK_ISSUE.LINKED_INVOICE_MISMATCH)
    expect(mismatch.linkable).toBeNull()
  })

  it('linked: agreeing invoice → no issue; missing / cancelled / mismatched → listed; malformed key → listed', () => {
    expect(claimLinkReconciliation(approvedClaim({ supplierInvoiceId: 'si9' }), [ex()])).toMatchObject({ issue: null, linkedInvoice: ex() })
    expect(claimLinkReconciliation(approvedClaim({ supplierInvoiceId: 'si9' }), []).issue).toBe(CLAIM_LINK_ISSUE.LINKED_INVOICE_MISSING)
    expect(claimLinkReconciliation(approvedClaim({ supplierInvoiceId: 'si9' }), [ex({ status: 'cancelled' })]).issue).toBe(CLAIM_LINK_ISSUE.LINKED_INVOICE_CANCELLED)
    expect(claimLinkReconciliation(approvedClaim({ supplierInvoiceId: 'si9' }), [ex({ supplierId: 'z' })]).issue).toBe(CLAIM_LINK_ISSUE.LINKED_INVOICE_MISMATCH)
    expect(claimLinkReconciliation(approvedClaim({ supplierInvoiceId: '' }), []).issue).toBe(CLAIM_LINK_ISSUE.MALFORMED_LINK)
    expect(Object.keys(CLAIM_LINK_ISSUE_LABELS).sort()).toEqual(Object.values(CLAIM_LINK_ISSUE).sort())
  })
})

// ── The link is workflow state, not recognition ──────────────────────────────

describe('financial invariants — the backlink moves no figure', () => {
  const PO = { id: 'po', poNumber: 'PO-0001', status: 'sent', lineItems: [{ costCodeId: 'c', costCodeName: 'C', description: 'Slab', lineTotal: 800 }] }
  const claimInv = (status, over = {}) => ({
    id: 'si1', invoiceNumber: 'SI-0001', status, source: SI_SOURCE.PROGRESS_CLAIM, poId: 'po', poNumber: 'PO-0001', progressClaimId: 'cl1',
    lineItems: INV_LINES, ...invoiceTotals(INV_LINES, 0), ...over,
  })

  it('Actual, Remaining Committed and the hand-over set are identical for a legacy, an unlinked and a linked claim — only POSTING hands over', () => {
    const { supplierInvoiceId: _a, ...legacy } = approvedClaim()   // eslint-disable-line no-unused-vars
    const linked = approvedClaim({ supplierInvoiceId: 'si1' })
    for (const claim of [legacy, approvedClaim(), linked]) {
      for (const status of ['draft', 'approved']) {
        const invoices = [claimInv(status)]
        expect(invoicedClaimIds(invoices).size).toBe(0)
        expect(actualClaimsByCostCode([claim], invoicedClaimIds(invoices))).toEqual({ c: 300 })
        expect(remainingCommitment({ purchaseOrders: [PO], progressClaims: [claim], supplierInvoices: invoices }).byCostCode).toEqual({ c: 500 })
      }
      const posted = [claimInv('posted')]
      expect(invoicedClaimIds(posted)).toEqual(new Set(['cl1']))
      expect(actualClaimsByCostCode([claim], invoicedClaimIds(posted))).toEqual({})
      expect(remainingCommitment({ purchaseOrders: [PO], progressClaims: [claim], supplierInvoices: posted }).byCostCode).toEqual({ c: 500 })
      // The register's own one-active-invoice fast-path is unchanged.
      expect(claimHasActiveInvoice([claimInv('draft')], 'cl1')).toBe(true)
      expect(claimHasActiveInvoice([claimInv('cancelled')], 'cl1')).toBe(false)
    }
  })

  it('no selector reads the link keys', () => {
    for (const rel of ['lib/supplierInvoices.js', 'lib/commitment.js', 'lib/forecast.js', 'lib/cashFlow.js', 'lib/purchaseOrders.js', 'lib/margin.js', 'lib/variations.js', 'lib/poLineRecognition.js', 'lib/projectSnapshot.js', 'lib/pulse.js']) {
      expect(read(rel), rel).not.toContain('supplierInvoiceId')
    }
  })

  it('no extra listener: the claims tab reuses its existing supplier-invoice subscription and the invoices tab its existing claims subscription', () => {
    const claims = read('pages/project/ProjectProgressClaims.jsx')
    expect(claims.match(/useSupplierInvoices\(/g)).toHaveLength(1)
    expect(claims).toContain('const registerSettled = !supplierInvoicesLoading && !supplierInvoicesError')
    const invoices = read('pages/project/ProjectInvoices.jsx')
    expect(invoices.match(/useProgressClaims\(/g)).toHaveLength(1)
    expect(invoices).toContain('isClaimInvoiceable(c) && !claimHasActiveInvoice(supplierInvoices, c.id)')
  })
})
