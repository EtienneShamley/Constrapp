import { describe, it, expect } from 'vitest'
import {
  runTransitionPurchaseOrder, transitionUpdate, PoWriteError, PO_WRITE_ERROR, poWriteErrorKind,
} from '../../src/lib/purchaseOrderActions'
import { PO_CANCEL_BLOCKER_KIND } from '../../src/lib/poCancellation'
import { PO_STATUS } from '../../src/lib/purchaseOrders'

// ── Guarded PO transitions — pure contract over a FAKE transaction (ADR-57) ──
//
// The emulator suite (tests/rules/purchaseOrders.rules.test.js) runs the real
// transaction against the real rules. This file pins the module's contract
// without Firestore: the exact update it writes, the order of its checks, and
// the error kinds — through an injected transaction whose reads are scripted.

const NOW = Symbol('serverTimestamp()')
const serverTimestamp = () => NOW

// A fake runTransaction: `docs` maps ref → data (undefined = missing). Records
// every update so a refused transition can be proven to have written nothing.
function fakeDb(docs) {
  const writes = []
  const tx = {
    get: async (ref) => ({ exists: () => docs[ref] !== undefined, id: ref, data: () => docs[ref] }),
    update: (ref, data) => writes.push({ ref, data }),
  }
  const runTransaction = async (_db, body) => body(tx)
  return { runTransaction, writes }
}

const seen = (status = 'draft') => ({ id: 'po1', poNumber: 'PO-0001', status })
const base = (overrides = {}) => ({ db: {}, poRef: 'po1', uid: 'u_qs', serverTimestamp, ...overrides })

async function expectKind(promise, kind) {
  let caught
  try { await promise } catch (e) { caught = e }
  expect(caught).toBeInstanceOf(PoWriteError)
  expect(caught.kind).toBe(kind)
  return caught
}

describe('transitionUpdate — the exact write', () => {
  it('writes status, the transition’s (at, by) pair and the two audit stamps — nothing else', () => {
    expect(transitionUpdate(PO_STATUS.SENT, 'u1', NOW)).toEqual({ status: 'sent', sentAt: NOW, sentBy: 'u1', updatedAt: NOW, updatedBy: 'u1' })
    expect(transitionUpdate(PO_STATUS.CLOSED, 'u1', NOW)).toEqual({ status: 'closed', closedAt: NOW, closedBy: 'u1', updatedAt: NOW, updatedBy: 'u1' })
    expect(transitionUpdate(PO_STATUS.CANCELLED, 'u1', NOW)).toEqual({ status: 'cancelled', cancelledAt: NOW, cancelledBy: 'u1', updatedAt: NOW, updatedBy: 'u1' })
  })

  it('has no write for the reserved pending_approval or for draft', () => {
    expect(() => transitionUpdate(PO_STATUS.PENDING_APPROVAL, 'u1', NOW)).toThrow(PoWriteError)
    expect(() => transitionUpdate(PO_STATUS.DRAFT, 'u1', NOW)).toThrow(PoWriteError)
  })
})

describe('runTransitionPurchaseOrder — checks before any read', () => {
  it('no uid → PERMISSION; no seen id → MISSING; illegal move → INVALID; reserved target → INVALID; nothing read or written', async () => {
    const { runTransaction, writes } = fakeDb({ po1: seen('draft') })
    await expectKind(runTransitionPurchaseOrder(base({ runTransaction, uid: null, seen: seen(), nextStatus: PO_STATUS.SENT })), PO_WRITE_ERROR.PERMISSION)
    await expectKind(runTransitionPurchaseOrder(base({ runTransaction, seen: {}, nextStatus: PO_STATUS.SENT })), PO_WRITE_ERROR.MISSING)
    await expectKind(runTransitionPurchaseOrder(base({ runTransaction, seen: seen('closed'), nextStatus: PO_STATUS.SENT })), PO_WRITE_ERROR.INVALID)
    await expectKind(runTransitionPurchaseOrder(base({ runTransaction, seen: seen('sent'), nextStatus: PO_STATUS.SENT })), PO_WRITE_ERROR.INVALID)
    const e = await expectKind(runTransitionPurchaseOrder(base({ runTransaction, seen: seen('draft'), nextStatus: PO_STATUS.PENDING_APPROVAL })), PO_WRITE_ERROR.INVALID)
    expect(e.message).toMatch(/reserved/)
    expect(writes).toEqual([])
  })
})

describe('runTransitionPurchaseOrder — inside the transaction', () => {
  it('send: writes exactly the transition update when the server copy matches', async () => {
    const { runTransaction, writes } = fakeDb({ po1: seen('draft') })
    const out = await runTransitionPurchaseOrder(base({ runTransaction, seen: seen('draft'), nextStatus: PO_STATUS.SENT }))
    expect(out).toEqual({ kind: null })
    expect(writes).toEqual([{ ref: 'po1', data: { status: 'sent', sentAt: NOW, sentBy: 'u_qs', updatedAt: NOW, updatedBy: 'u_qs' } }])
  })

  it('missing on the server → MISSING; status moved underneath → STALE naming both statuses; nothing written', async () => {
    const gone = fakeDb({})
    await expectKind(runTransitionPurchaseOrder(base({ runTransaction: gone.runTransaction, seen: seen('draft'), nextStatus: PO_STATUS.SENT })), PO_WRITE_ERROR.MISSING)
    const moved = fakeDb({ po1: seen('cancelled') })
    const e = await expectKind(runTransitionPurchaseOrder(base({ runTransaction: moved.runTransaction, seen: seen('draft'), nextStatus: PO_STATUS.SENT })), PO_WRITE_ERROR.STALE)
    expect(e.message).toContain('PO-0001 is now Cancelled, not Draft')
    expect(gone.writes).toEqual([])
    expect(moved.writes).toEqual([])
  })

  it('cancel: re-reads every linked ref and is BLOCKED by a server copy that still counts, with the blockers attached', async () => {
    const { runTransaction, writes } = fakeDb({
      po1: seen('sent'),
      c1: { claimNumber: 'PC-0001', status: 'rejected', poId: 'po1' },
      c2: { claimNumber: 'PC-0002', status: 'approved', poId: 'po1' },
      i1: { invoiceNumber: 'SI-0001', status: 'cancelled', poId: 'po1' },
    })
    const e = await expectKind(runTransitionPurchaseOrder(base({
      runTransaction, seen: seen('sent'), nextStatus: PO_STATUS.CANCELLED,
      linkedRefs: [
        { kind: PO_CANCEL_BLOCKER_KIND.CLAIM, ref: 'c1' }, { kind: PO_CANCEL_BLOCKER_KIND.CLAIM, ref: 'c2' },
        { kind: PO_CANCEL_BLOCKER_KIND.INVOICE, ref: 'i1' },
      ],
    })), PO_WRITE_ERROR.BLOCKED)
    expect(e.blockers).toEqual([{ kind: 'claim', id: 'c2', number: 'PC-0002', status: 'approved', statusLabel: 'Approved' }])
    expect(e.message).toContain('PO-0001 cannot be cancelled: it has 1 progress claim — PC-0002 (Approved)')
    expect(writes).toEqual([])
  })

  it('cancel: succeeds when every server copy is terminal, a vanished ref is ignored, and an unknown kind is ignored', async () => {
    const { runTransaction, writes } = fakeDb({
      po1: seen('sent'),
      c1: { claimNumber: 'PC-0001', status: 'rejected', poId: 'po1' },
      i1: { invoiceNumber: 'SI-0001', status: 'cancelled', poId: 'po1' },
      x1: { status: 'approved', poId: 'po1' },
    })
    await runTransitionPurchaseOrder(base({
      runTransaction, seen: seen('sent'), nextStatus: PO_STATUS.CANCELLED,
      linkedRefs: [
        { kind: PO_CANCEL_BLOCKER_KIND.CLAIM, ref: 'c1' }, { kind: PO_CANCEL_BLOCKER_KIND.INVOICE, ref: 'i1' },
        { kind: PO_CANCEL_BLOCKER_KIND.CLAIM, ref: 'gone' }, { kind: 'variation', ref: 'x1' },
      ],
    }))
    expect(writes).toEqual([{ ref: 'po1', data: { status: 'cancelled', cancelledAt: NOW, cancelledBy: 'u_qs', updatedAt: NOW, updatedBy: 'u_qs' } }])
  })

  it('cancel: a server copy of an approved SUPPLIER variation blocks; a withdrawn one and a client one do not', async () => {
    const blocked = fakeDb({ po1: seen('sent'), v1: { variationNumber: 'SV-0001', variationType: 'supplier', status: 'approved', poId: 'po1' } })
    const e = await expectKind(runTransitionPurchaseOrder(base({
      runTransaction: blocked.runTransaction, seen: seen('sent'), nextStatus: PO_STATUS.CANCELLED,
      linkedRefs: [{ kind: PO_CANCEL_BLOCKER_KIND.VARIATION, ref: 'v1' }],
    })), PO_WRITE_ERROR.BLOCKED)
    expect(e.blockers).toEqual([{ kind: 'variation', id: 'v1', number: 'SV-0001', status: 'approved', statusLabel: 'Approved' }])
    expect(blocked.writes).toEqual([])
    const clear = fakeDb({
      po1: seen('sent'),
      v2: { variationType: 'supplier', status: 'withdrawn', poId: 'po1' },
      v3: { variationType: 'client', status: 'approved', poId: 'po1' },
    })
    await runTransitionPurchaseOrder(base({
      runTransaction: clear.runTransaction, seen: seen('sent'), nextStatus: PO_STATUS.CANCELLED,
      linkedRefs: [{ kind: PO_CANCEL_BLOCKER_KIND.VARIATION, ref: 'v2' }, { kind: PO_CANCEL_BLOCKER_KIND.VARIATION, ref: 'v3' }],
    }))
    expect(clear.writes).toHaveLength(1)
  })

  it('a linked record whose server copy points at ANOTHER PO does not block', async () => {
    const { runTransaction, writes } = fakeDb({ po1: seen('sent'), c9: { status: 'approved', poId: 'po-other' } })
    await runTransitionPurchaseOrder(base({
      runTransaction, seen: seen('sent'), nextStatus: PO_STATUS.CANCELLED,
      linkedRefs: [{ kind: PO_CANCEL_BLOCKER_KIND.CLAIM, ref: 'c9' }],
    }))
    expect(writes).toHaveLength(1)
  })

  it('send and close never read linked refs', async () => {
    let reads = 0
    const docs = { po1: seen('sent') }
    const tx = { get: async (ref) => { reads++; return { exists: () => docs[ref] !== undefined, id: ref, data: () => docs[ref] } }, update: () => {} }
    await runTransitionPurchaseOrder(base({
      runTransaction: async (_db, body) => body(tx), seen: seen('sent'), nextStatus: PO_STATUS.CLOSED,
      linkedRefs: [{ kind: PO_CANCEL_BLOCKER_KIND.CLAIM, ref: 'c1' }],
    }))
    expect(reads).toBe(1)
  })
})

describe('error mapping', () => {
  it('maps Firestore codes to kinds and wraps unknown failures', async () => {
    expect(poWriteErrorKind('permission-denied')).toBe(PO_WRITE_ERROR.PERMISSION)
    expect(poWriteErrorKind('unavailable')).toBe(PO_WRITE_ERROR.OFFLINE)
    expect(poWriteErrorKind('deadline-exceeded')).toBe(PO_WRITE_ERROR.OFFLINE)
    expect(poWriteErrorKind('not-found')).toBe(PO_WRITE_ERROR.MISSING)
    expect(poWriteErrorKind('whatever')).toBe(PO_WRITE_ERROR.UNKNOWN)
    const boom = async () => { const e = new Error('denied'); e.code = 'permission-denied'; throw e }
    const e = await expectKind(runTransitionPurchaseOrder(base({ runTransaction: boom, seen: seen('draft'), nextStatus: PO_STATUS.SENT })), PO_WRITE_ERROR.PERMISSION)
    expect(e.cause.code).toBe('permission-denied')
    expect(e.message).toMatch(/permission/)
  })
})
