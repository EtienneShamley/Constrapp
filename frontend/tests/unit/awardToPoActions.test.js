import { describe, it, expect } from 'vitest'
import { runRaisePurchaseOrderFromAward, backlinkUpdate, AWARD_PO_ERROR } from '../../src/lib/awardToPoActions'
import { PoWriteError } from '../../src/lib/purchaseOrderActions'

// ── Guarded raise — pure contract over a FAKE transaction (ADR-61) ───────────
//
// The emulator suite (tests/rules/awardToPo.rules.test.js) runs the real
// transaction against the real rules. This file pins the module's contract
// without Firestore: the order of its checks, the exact writes, the error
// kinds, and that a refused raise writes NOTHING (no counter, no PO, no link).

const NOW = Symbol('serverTimestamp()')
const serverTimestamp = () => NOW

const ref = (id) => ({ id, path: id })
const REFS = { counterRef: ref('counter'), packageRef: ref('pkg1'), bidRef: ref('bid1'), poRef: ref('po_new'), previousPoRef: null }

const LINES = [{ costCodeId: 'cc1', costCodeName: '01-100 — Steel', description: '', amount: 1000 }]
const pkgDoc = (o = {}) => ({ tenderNumber: 'TP-0007', status: 'awarded', awardedBidId: 'bid1', costCodes: [{ costCodeId: 'cc1', costCodeName: '01-100 — Steel' }], ...o })
const bidDoc = (o = {}) => ({ tenderPackageId: 'pkg1', status: 'received', bidderContactId: 'supplier1', bidderName: 'Apex', lineItems: LINES, ...o })
const seen = (o = {}) => ({ pkg: { id: 'pkg1', tenderNumber: 'TP-0007', ...o.pkg }, bid: { id: 'bid1', bidderContactId: 'supplier1', bidderName: 'Apex', lineItems: LINES, ...o.bid } })

function fakeDb(docs) {
  const writes = []
  const reads = []
  const tx = {
    get: async (r) => { reads.push(r.id); return { exists: () => docs[r.id] !== undefined, id: r.id, data: () => docs[r.id] } },
    set: (r, data, opts) => writes.push({ op: 'set', ref: r.id, data, opts }),
    update: (r, data) => writes.push({ op: 'update', ref: r.id, data }),
  }
  const runTransaction = async (_db, body) => body(tx)
  return { runTransaction, writes, reads }
}

const buildDocument = ({ poNumber, now }) => ({ poNumber, now, status: 'draft', built: true })
const base = (o = {}) => ({ db: {}, uid: 'u_qs', serverTimestamp, refs: REFS, seen: seen(), buildDocument, ...o })

async function expectKind(promise, kind) {
  let caught
  try { await promise } catch (e) { caught = e }
  expect(caught).toBeInstanceOf(PoWriteError)
  expect(caught.kind).toBe(kind)
  return caught
}

describe('backlinkUpdate — the exact package write', () => {
  it('writes the four link keys and the two audit stamps, nothing else', () => {
    expect(backlinkUpdate({ poId: 'po_new', poNumber: 'PO-0002', uid: 'u1', now: NOW })).toEqual({
      raisedPoId: 'po_new', raisedPoNumber: 'PO-0002', raisedPoAt: NOW, raisedPoBy: 'u1', updatedAt: NOW, updatedBy: 'u1',
    })
  })
})

describe('checks before any read', () => {
  it('no uid → PERMISSION; no seen ids → MISSING; no builder or ref → INVALID; nothing read or written', async () => {
    const { runTransaction, writes, reads } = fakeDb({})
    await expectKind(runRaisePurchaseOrderFromAward(base({ runTransaction, uid: null })), AWARD_PO_ERROR.PERMISSION)
    await expectKind(runRaisePurchaseOrderFromAward(base({ runTransaction, seen: { pkg: {}, bid: { id: 'b' } } })), AWARD_PO_ERROR.MISSING)
    await expectKind(runRaisePurchaseOrderFromAward(base({ runTransaction, buildDocument: null })), AWARD_PO_ERROR.INVALID)
    await expectKind(runRaisePurchaseOrderFromAward(base({ runTransaction, refs: { ...REFS, poRef: null } })), AWARD_PO_ERROR.INVALID)
    expect(writes).toEqual([])
    expect(reads).toEqual([])
  })
})

describe('inside the transaction — the happy path', () => {
  it('reads counter, package, bid (and project through the lock) before writing counter + PO + back-link + lock, in that order', async () => {
    const { runTransaction, writes, reads } = fakeDb({ counter: { next: 7 }, pkg1: pkgDoc(), bid1: bidDoc() })
    let lockCommitted = false
    const stageCurrencyLock = async (tx) => { reads.push('project'); return () => { lockCommitted = true; tx.update(ref('project'), { currencyLocked: true }) } }
    const out = await runRaisePurchaseOrderFromAward(base({ runTransaction, stageCurrencyLock }))
    expect(out).toEqual({ kind: null, poId: 'po_new', poNumber: 'PO-0007' })
    expect(reads).toEqual(['counter', 'pkg1', 'bid1', 'project'])
    expect(writes).toEqual([
      { op: 'set', ref: 'counter', data: { next: 8 }, opts: { merge: true } },
      { op: 'set', ref: 'po_new', data: { poNumber: 'PO-0007', now: NOW, status: 'draft', built: true }, opts: undefined },
      { op: 'update', ref: 'pkg1', data: { raisedPoId: 'po_new', raisedPoNumber: 'PO-0007', raisedPoAt: NOW, raisedPoBy: 'u_qs', updatedAt: NOW, updatedBy: 'u_qs' } },
      { op: 'update', ref: 'project', data: { currencyLocked: true } },
    ])
    expect(lockCommitted).toBe(true)
  })

  it('a missing counter starts the sequence at PO-0001; no lock stager is tolerated', async () => {
    const { runTransaction, writes } = fakeDb({ pkg1: pkgDoc(), bid1: bidDoc() })
    const out = await runRaisePurchaseOrderFromAward(base({ runTransaction }))
    expect(out.poNumber).toBe('PO-0001')
    expect(writes[0]).toEqual({ op: 'set', ref: 'counter', data: { next: 2 }, opts: { merge: true } })
    expect(writes).toHaveLength(3)
  })
})

describe('inside the transaction — refusals write nothing', () => {
  it('package missing → MISSING; not awarded, or awarded to another bid → STALE', async () => {
    const gone = fakeDb({ counter: { next: 1 }, bid1: bidDoc() })
    await expectKind(runRaisePurchaseOrderFromAward(base({ runTransaction: gone.runTransaction })), AWARD_PO_ERROR.MISSING)
    const issued = fakeDb({ counter: { next: 1 }, pkg1: pkgDoc({ status: 'issued' }), bid1: bidDoc() })
    const e = await expectKind(runRaisePurchaseOrderFromAward(base({ runTransaction: issued.runTransaction })), AWARD_PO_ERROR.STALE)
    expect(e.message).toContain('TP-0007 is now issued')
    const other = fakeDb({ counter: { next: 1 }, pkg1: pkgDoc({ awardedBidId: 'bid9' }), bid1: bidDoc() })
    const e2 = await expectKind(runRaisePurchaseOrderFromAward(base({ runTransaction: other.runTransaction })), AWARD_PO_ERROR.STALE)
    expect(e2.message).toContain('awarded to a different bid')
    for (const f of [gone, issued, other]) expect(f.writes).toEqual([])
  })

  it('bid missing → MISSING; void, other package, or different from the reviewed copy → STALE', async () => {
    const gone = fakeDb({ counter: { next: 1 }, pkg1: pkgDoc() })
    await expectKind(runRaisePurchaseOrderFromAward(base({ runTransaction: gone.runTransaction })), AWARD_PO_ERROR.MISSING)
    const voided = fakeDb({ counter: { next: 1 }, pkg1: pkgDoc(), bid1: bidDoc({ status: 'void' }) })
    await expectKind(runRaisePurchaseOrderFromAward(base({ runTransaction: voided.runTransaction })), AWARD_PO_ERROR.STALE)
    const otherPkg = fakeDb({ counter: { next: 1 }, pkg1: pkgDoc(), bid1: bidDoc({ tenderPackageId: 'pkg9' }) })
    await expectKind(runRaisePurchaseOrderFromAward(base({ runTransaction: otherPkg.runTransaction })), AWARD_PO_ERROR.STALE)
    const changed = fakeDb({ counter: { next: 1 }, pkg1: pkgDoc(), bid1: bidDoc({ lineItems: [{ ...LINES[0], amount: 999 }] }) })
    const e = await expectKind(runRaisePurchaseOrderFromAward(base({ runTransaction: changed.runTransaction })), AWARD_PO_ERROR.STALE)
    expect(e.message).toContain('differs from the one you reviewed')
    const renamed = fakeDb({ counter: { next: 1 }, pkg1: pkgDoc(), bid1: bidDoc({ bidderName: 'Other' }) })
    await expectKind(runRaisePurchaseOrderFromAward(base({ runTransaction: renamed.runTransaction })), AWARD_PO_ERROR.STALE)
    for (const f of [gone, voided, otherPkg, changed, renamed]) expect(f.writes).toEqual([])
  })

  it('a bid failing the validity gate on the server → INVALID', async () => {
    const bad = [{ costCodeId: 'cc1', costCodeName: '', description: '', amount: -1 }]
    const f = fakeDb({ counter: { next: 1 }, pkg1: pkgDoc(), bid1: bidDoc({ lineItems: bad }) })
    await expectKind(runRaisePurchaseOrderFromAward(base({ runTransaction: f.runTransaction, seen: seen({ bid: { lineItems: bad } }) })), AWARD_PO_ERROR.INVALID)
    expect(f.writes).toEqual([])
  })

  it('a package already linked → ALREADY_RAISED unless the caller re-read THAT PO and it is cancelled', async () => {
    // Linked, caller did not know (no previousPoRef).
    const unknown = fakeDb({ counter: { next: 1 }, pkg1: pkgDoc({ raisedPoId: 'po_old', raisedPoNumber: 'PO-0003' }), bid1: bidDoc() })
    const e = await expectKind(runRaisePurchaseOrderFromAward(base({ runTransaction: unknown.runTransaction })), AWARD_PO_ERROR.ALREADY_RAISED)
    expect(e.message).toContain('PO-0003 has already been raised')
    // Linked to a different PO than the caller re-read.
    const mismatch = fakeDb({ counter: { next: 1 }, pkg1: pkgDoc({ raisedPoId: 'po_other' }), bid1: bidDoc(), po_old: { status: 'cancelled' } })
    await expectKind(runRaisePurchaseOrderFromAward(base({ runTransaction: mismatch.runTransaction, refs: { ...REFS, previousPoRef: ref('po_old') } })), AWARD_PO_ERROR.ALREADY_RAISED)
    // Linked to a PO that is still draft / sent / closed.
    for (const status of ['draft', 'sent', 'closed']) {
      const active = fakeDb({ counter: { next: 1 }, pkg1: pkgDoc({ raisedPoId: 'po_old' }), bid1: bidDoc(), po_old: { status, poNumber: 'PO-0003' } })
      const e2 = await expectKind(runRaisePurchaseOrderFromAward(base({ runTransaction: active.runTransaction, refs: { ...REFS, previousPoRef: ref('po_old') } })), AWARD_PO_ERROR.ALREADY_RAISED)
      expect(e2.message).toContain(`PO-0003 has already been raised from this award and is ${status}`)
      expect(active.writes).toEqual([])
    }
    // Linked to a PO that cannot be read.
    const vanished = fakeDb({ counter: { next: 1 }, pkg1: pkgDoc({ raisedPoId: 'po_old' }), bid1: bidDoc() })
    await expectKind(runRaisePurchaseOrderFromAward(base({ runTransaction: vanished.runTransaction, refs: { ...REFS, previousPoRef: ref('po_old') } })), AWARD_PO_ERROR.ALREADY_RAISED)
    for (const f of [unknown, mismatch, vanished]) expect(f.writes).toEqual([])
  })

  it('a re-raise after a CANCELLED linked PO proceeds and relinks the package', async () => {
    const f = fakeDb({ counter: { next: 4 }, pkg1: pkgDoc({ raisedPoId: 'po_old', raisedPoNumber: 'PO-0003' }), bid1: bidDoc(), po_old: { status: 'cancelled', poNumber: 'PO-0003' } })
    const out = await runRaisePurchaseOrderFromAward(base({ runTransaction: f.runTransaction, refs: { ...REFS, previousPoRef: ref('po_old') } }))
    expect(out).toEqual({ kind: null, poId: 'po_new', poNumber: 'PO-0004' })
    expect(f.reads).toEqual(['counter', 'pkg1', 'bid1', 'po_old'])
    expect(f.writes[2]).toEqual({ op: 'update', ref: 'pkg1', data: { raisedPoId: 'po_new', raisedPoNumber: 'PO-0004', raisedPoAt: NOW, raisedPoBy: 'u_qs', updatedAt: NOW, updatedBy: 'u_qs' } })
  })

  it('SDK errors map to kinds — permission-denied → PERMISSION, unavailable → OFFLINE, other → UNKNOWN; a PoWriteError passes through', async () => {
    const failing = (code) => async () => { const e = new Error('x'); e.code = code; throw e }
    await expectKind(runRaisePurchaseOrderFromAward(base({ runTransaction: failing('permission-denied') })), AWARD_PO_ERROR.PERMISSION)
    await expectKind(runRaisePurchaseOrderFromAward(base({ runTransaction: failing('unavailable') })), AWARD_PO_ERROR.OFFLINE)
    await expectKind(runRaisePurchaseOrderFromAward(base({ runTransaction: failing('weird') })), AWARD_PO_ERROR.UNKNOWN)
    const passthrough = async () => { throw new PoWriteError(AWARD_PO_ERROR.BLOCKED, 'blocked by the proposal') }
    const e = await expectKind(runRaisePurchaseOrderFromAward(base({ runTransaction: passthrough })), AWARD_PO_ERROR.BLOCKED)
    expect(e.message).toBe('blocked by the proposal')
  })
})
