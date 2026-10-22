import { describe, it, expect } from 'vitest'
import {
  BOQ_WRITE_ERROR, BOQ_WRITE_ERROR_MESSAGES, BoqWriteError, boqWriteErrorKind,
  sameStamp, boqVersionMatches, runUpdateBoqItem, runApplyBoqQuantity,
} from '../../src/lib/boqActions.js'
import { boqLineAmount } from '../../src/lib/boq.js'

// ── Guarded BOQ writes against an in-memory Firestore stand-in (ADR-52) ──────
//
// The REAL transactions run against the emulator in
// tests/rules/boqItems.rules.test.js; here the contract is proven in plain
// Node: server read, active check, version comparison (stamps, then content
// for legacy records), derived amount, ratchet staging, exact write shape.

function fakeFirestore({ failWith = null } = {}) {
  const store = new Map()
  const ref = (path) => ({ path, id: path.split('/').pop() })
  const runTransaction = async (_db, body) => {
    if (failWith) throw Object.assign(new Error(failWith), { code: failWith })
    const writes = []
    const tx = {
      get: async (r) => {
        const data = store.get(r.path)
        return { id: r.id, exists: () => data !== undefined, data: () => data }
      },
      set: (r, data) => writes.push(['set', r, data]),
      update: (r, data) => writes.push(['update', r, data]),
    }
    const out = await body(tx)
    for (const [op, r, data] of writes) {
      if (op === 'set') store.set(r.path, data)
      else store.set(r.path, { ...store.get(r.path), ...data })
    }
    return out
  }
  const serverTimestamp = () => ({ __serverTimestamp: true })
  return { db: {}, store, ref, runTransaction, serverTimestamp }
}

// A Timestamp-like with the SDK's isEqual.
const TS = (seconds, nanoseconds = 0) => ({ seconds, nanoseconds, isEqual(o) { return !!o && o.seconds === seconds && (o.nanoseconds ?? 0) === nanoseconds } })
const PATH = 'companies/c/projects/p/boqItems/b1'
// A fingerprint as lib/quantBoq.js → evidenceFingerprint produces it.
const EV = 'v1:0123456789abcdef'

const stored = (overrides = {}) => ({
  itemNumber: '2.1', section: 'Substructure', description: 'Formwork to slab edge', unit: 'm2',
  quantity: 10, rate: 85, amount: 850, costCodeId: 'cc1', costCodeName: '04-100 — Formwork', notes: '',
  status: 'active', currency: 'AUD', revision: 1, attachments: [], externalRefs: {},
  voidReason: '', voidedAt: null, voidedBy: null,
  createdAt: TS(1), createdBy: 'u0', updatedAt: TS(100), updatedBy: 'u0',
  ...overrides,
})
const seen = (overrides = {}) => ({ id: 'b1', ...stored(), ...overrides })

// The hook's buildFields output for an edit.
const fields = (overrides = {}) => ({
  itemNumber: '2.1', section: 'Substructure', description: 'Formwork to slab edge, N32', unit: 'm2',
  quantity: 14, rate: 90, amount: boqLineAmount(14, 90), costCodeId: 'cc1', costCodeName: '04-100 — Formwork', notes: '',
  ...overrides,
})

// A ratchet stand-in that records whether it was staged and committed.
function lockSpy() {
  const calls = { staged: 0, committed: 0 }
  const stageLock = async () => { calls.staged += 1; return () => { calls.committed += 1 } }
  return { stageLock, calls }
}

const expectKind = async (promise, kind, messagePattern) => {
  let caught = null
  try { await promise } catch (err) { caught = err }
  expect(caught).toBeInstanceOf(BoqWriteError)
  expect(caught.kind).toBe(kind)
  expect(caught.message).toBeTruthy()
  if (messagePattern) expect(caught.message).toMatch(messagePattern)
  return caught
}

// ── Version comparison ───────────────────────────────────────────────────────

describe('sameStamp / boqVersionMatches', () => {
  it('compares Timestamps by value, accepts plain {seconds, nanoseconds}, and refuses non-stamps', () => {
    expect(sameStamp(TS(5, 1), TS(5, 1))).toBe(true)
    expect(sameStamp(TS(5, 1), TS(5, 2))).toBe(false)
    expect(sameStamp({ seconds: 5, nanoseconds: 0 }, { seconds: 5 })).toBe(true)
    expect(sameStamp(TS(5), { seconds: 5, nanoseconds: 0 })).toBe(true)
    expect(sameStamp(null, TS(5))).toBe(false)
    expect(sameStamp({ __serverTimestamp: true }, TS(5))).toBe(false)
    expect(sameStamp('2026-01-01', '2026-01-01')).toBe(false)
  })

  it('with stamps on both sides, the stamps decide — even when content happens to match', () => {
    expect(boqVersionMatches(seen(), stored())).toBe(true)
    expect(boqVersionMatches(seen(), stored({ updatedAt: TS(101) }))).toBe(false)
    expect(boqVersionMatches(seen({ updatedAt: TS(99) }), stored())).toBe(false)
  })

  it('LEGACY: a missing or incomplete updatedAt on either side falls back to a field-by-field guard — never to "match"', () => {
    expect(boqVersionMatches(seen({ updatedAt: null }), stored({ updatedAt: null }))).toBe(true)
    expect(boqVersionMatches(seen({ updatedAt: undefined }), stored())).toBe(true)      // content equal
    expect(boqVersionMatches(seen({ updatedAt: null }), stored({ quantity: 11 }))).toBe(false)
    expect(boqVersionMatches(seen({ updatedAt: null }), stored({ rate: null, amount: null }))).toBe(false)
    expect(boqVersionMatches(seen({ updatedAt: null }), stored({ unit: 'm3' }))).toBe(false)
    expect(boqVersionMatches(seen({ updatedAt: null }), stored({ costCodeId: 'cc9' }))).toBe(false)
    expect(boqVersionMatches(seen({ updatedAt: null }), stored({ status: 'void' }))).toBe(false)
    expect(boqVersionMatches(seen({ updatedAt: null }), stored({ description: 'changed' }))).toBe(false)
    expect(boqVersionMatches(seen({ updatedAt: 'not-a-stamp' }), stored({ notes: 'x' }))).toBe(false)
  })

  it('nothing to compare → no match', () => {
    expect(boqVersionMatches(null, stored())).toBe(false)
    expect(boqVersionMatches(seen(), undefined)).toBe(false)
  })
})

// ── Error vocabulary ─────────────────────────────────────────────────────────

describe('error vocabulary', () => {
  it('maps SDK codes; every kind has a message; a permission error is a rules rejection, unavailable is the network', () => {
    expect(boqWriteErrorKind('permission-denied')).toBe(BOQ_WRITE_ERROR.PERMISSION)
    expect(boqWriteErrorKind('unavailable')).toBe(BOQ_WRITE_ERROR.OFFLINE)
    expect(boqWriteErrorKind('deadline-exceeded')).toBe(BOQ_WRITE_ERROR.OFFLINE)
    expect(boqWriteErrorKind('not-found')).toBe(BOQ_WRITE_ERROR.MISSING)
    expect(boqWriteErrorKind('weird')).toBe(BOQ_WRITE_ERROR.UNKNOWN)
    for (const k of Object.values(BOQ_WRITE_ERROR)) expect(BOQ_WRITE_ERROR_MESSAGES[k]).toBeTruthy()
    expect(new BoqWriteError(BOQ_WRITE_ERROR.STALE).message).toMatch(/Another user changed this BOQ item/)
    expect(new BoqWriteError(BOQ_WRITE_ERROR.INVALID, 'custom').message).toBe('custom')
  })

  it('SDK failures surface as the mapped kind and nothing is written', async () => {
    for (const [code, kind] of [['permission-denied', BOQ_WRITE_ERROR.PERMISSION], ['unavailable', BOQ_WRITE_ERROR.OFFLINE], ['internal', BOQ_WRITE_ERROR.UNKNOWN]]) {
      const f = fakeFirestore({ failWith: code })
      const { stageLock } = lockSpy()
      await expectKind(runApplyBoqQuantity({ ...f, itemRef: f.ref(PATH), seen: seen(), quantity: 12, measurementCount: 1, evidence: EV, uid: 'u1', stageLock }), kind)
      expect(f.store.size).toBe(0)
    }
  })
})

// ── The manual editor's save ─────────────────────────────────────────────────

describe('runUpdateBoqItem — the ADR-32 edit, now version-guarded', () => {
  it('writes the normalised fields with stamps, stages the ratchet when priced, and preserves everything else', async () => {
    const f = fakeFirestore()
    f.store.set(PATH, stored())
    const { stageLock, calls } = lockSpy()
    const out = await runUpdateBoqItem({ ...f, itemRef: f.ref(PATH), seen: seen(), fields: fields(), uid: 'u1', stageLock })
    expect(out).toEqual({ kind: null })
    const doc = f.store.get(PATH)
    expect(doc).toMatchObject({ description: 'Formwork to slab edge, N32', quantity: 14, rate: 90, amount: 1260, updatedBy: 'u1', updatedAt: { __serverTimestamp: true } })
    expect(doc).toMatchObject({ createdBy: 'u0', currency: 'AUD', revision: 1, status: 'active', voidedAt: null })
    expect(calls).toEqual({ staged: 1, committed: 1 })
  })

  it('un-pricing stages no ratchet; pricing an unpriced item does', async () => {
    const f = fakeFirestore()
    f.store.set(PATH, stored())
    const a = lockSpy()
    await runUpdateBoqItem({ ...f, itemRef: f.ref(PATH), seen: seen(), fields: fields({ rate: null, amount: null }), uid: 'u1', stageLock: a.stageLock })
    expect(a.calls.staged).toBe(0)
    expect(f.store.get(PATH)).toMatchObject({ rate: null, amount: null })

    const g = fakeFirestore()
    g.store.set(PATH, stored({ rate: null, amount: null }))
    const b = lockSpy()
    await runUpdateBoqItem({ ...g, itemRef: g.ref(PATH), seen: seen({ rate: null, amount: null }), fields: fields({ rate: 5, amount: boqLineAmount(14, 5) }), uid: 'u1', stageLock: b.stageLock })
    expect(b.calls).toEqual({ staged: 1, committed: 1 })
  })

  it('refuses a STALE copy — a newer save underneath is never overwritten', async () => {
    const f = fakeFirestore()
    f.store.set(PATH, stored({ quantity: 11, amount: 935, updatedAt: TS(200), updatedBy: 'u9' }))
    const { stageLock, calls } = lockSpy()
    await expectKind(runUpdateBoqItem({ ...f, itemRef: f.ref(PATH), seen: seen(), fields: fields(), uid: 'u1', stageLock }), BOQ_WRITE_ERROR.STALE)
    expect(f.store.get(PATH)).toMatchObject({ quantity: 11, updatedBy: 'u9' })
    expect(calls.staged).toBe(0)
  })

  it('LEGACY record with no updatedAt: identical content proceeds; changed content is STALE — never an unguarded overwrite', async () => {
    const f = fakeFirestore()
    f.store.set(PATH, stored({ updatedAt: null }))
    const { stageLock } = lockSpy()
    await runUpdateBoqItem({ ...f, itemRef: f.ref(PATH), seen: seen({ updatedAt: null }), fields: fields(), uid: 'u1', stageLock })
    expect(f.store.get(PATH).quantity).toBe(14)

    const g = fakeFirestore()
    g.store.set(PATH, stored({ updatedAt: null, quantity: 99, amount: boqLineAmount(99, 85) }))
    await expectKind(runUpdateBoqItem({ ...g, itemRef: g.ref(PATH), seen: seen({ updatedAt: null }), fields: fields(), uid: 'u1', stageLock }), BOQ_WRITE_ERROR.STALE)
    expect(g.store.get(PATH).quantity).toBe(99)
  })

  it('refuses a missing item, a void item (seen or server), an invalid draft and a missing actor', async () => {
    const f = fakeFirestore()
    const { stageLock } = lockSpy()
    await expectKind(runUpdateBoqItem({ ...f, itemRef: f.ref(PATH), seen: seen(), fields: fields(), uid: 'u1', stageLock }), BOQ_WRITE_ERROR.MISSING)
    await expectKind(runUpdateBoqItem({ ...f, itemRef: f.ref(PATH), seen: seen({ status: 'void' }), fields: fields(), uid: 'u1', stageLock }), BOQ_WRITE_ERROR.INVALID, /active/)
    f.store.set(PATH, stored({ status: 'void' }))
    await expectKind(runUpdateBoqItem({ ...f, itemRef: f.ref(PATH), seen: seen(), fields: fields(), uid: 'u1', stageLock }), BOQ_WRITE_ERROR.INVALID)
    f.store.set(PATH, stored())
    await expectKind(runUpdateBoqItem({ ...f, itemRef: f.ref(PATH), seen: seen(), fields: fields({ quantity: -1 }), uid: 'u1', stageLock }), BOQ_WRITE_ERROR.INVALID, /negative/)
    await expectKind(runUpdateBoqItem({ ...f, itemRef: f.ref(PATH), seen: seen(), fields: fields(), uid: '', stageLock }), BOQ_WRITE_ERROR.PERMISSION)
    expect(f.store.get(PATH).quantity).toBe(10)
  })
})

// ── Quant apply ──────────────────────────────────────────────────────────────

describe('runApplyBoqQuantity — a reviewed measured total, applied once, explicitly', () => {
  it('priced: writes quantity, the amount derived from the SERVER rate, the provenance map and stamps — nothing else — and stages the ratchet', async () => {
    const f = fakeFirestore()
    f.store.set(PATH, stored())
    const { stageLock, calls } = lockSpy()
    const writesBefore = { ...f.store.get(PATH) }
    const out = await runApplyBoqQuantity({ ...f, itemRef: f.ref(PATH), seen: seen(), quantity: 12, measurementCount: 1, evidence: EV, uid: 'u1', stageLock })
    expect(out).toEqual({ kind: null, quantity: 12, amount: 1020 })
    const doc = f.store.get(PATH)
    expect(doc.quantity).toBe(12)
    expect(doc.amount).toBe(boqLineAmount(12, 85))
    expect(doc.quantApplied).toEqual({ at: { __serverTimestamp: true }, by: 'u1', quantity: 12, measurementCount: 1, evidence: EV })
    expect(doc.updatedBy).toBe('u1')
    expect(doc.updatedAt).toEqual({ __serverTimestamp: true })
    // Every other field is preserved verbatim.
    for (const k of Object.keys(writesBefore)) {
      if (!['quantity', 'amount', 'updatedAt', 'updatedBy'].includes(k)) expect(doc[k], k).toEqual(writesBefore[k])
    }
    expect(calls).toEqual({ staged: 1, committed: 1 })
  })

  it('unpriced: the quantity changes, the amount stays null, no monetary figure, no ratchet', async () => {
    const f = fakeFirestore()
    f.store.set(PATH, stored({ rate: null, amount: null }))
    const { stageLock, calls } = lockSpy()
    const out = await runApplyBoqQuantity({ ...f, itemRef: f.ref(PATH), seen: seen({ rate: null, amount: null }), quantity: 3, measurementCount: 2, evidence: EV, uid: 'u1', stageLock })
    expect(out).toEqual({ kind: null, quantity: 3, amount: null })
    expect(f.store.get(PATH)).toMatchObject({ quantity: 3, rate: null, amount: null, quantApplied: { quantity: 3, measurementCount: 2 } })
    expect(calls.staged).toBe(0)
  })

  it('a zero rate is a price: amount 0, ratchet staged', async () => {
    const f = fakeFirestore()
    f.store.set(PATH, stored({ rate: 0, amount: 0 }))
    const { stageLock, calls } = lockSpy()
    await runApplyBoqQuantity({ ...f, itemRef: f.ref(PATH), seen: seen({ rate: 0, amount: 0 }), quantity: 12, measurementCount: 1, evidence: EV, uid: 'u1', stageLock })
    expect(f.store.get(PATH)).toMatchObject({ quantity: 12, amount: 0 })
    expect(calls.staged).toBe(1)
  })

  it('refuses a STALE copy: a rate changed underneath is detected and the reviewed amount is never written', async () => {
    const f = fakeFirestore()
    f.store.set(PATH, stored({ rate: 100, amount: 1000, updatedAt: TS(200) }))
    const { stageLock, calls } = lockSpy()
    await expectKind(runApplyBoqQuantity({ ...f, itemRef: f.ref(PATH), seen: seen(), quantity: 12, measurementCount: 1, evidence: EV, uid: 'u1', stageLock }), BOQ_WRITE_ERROR.STALE)
    expect(f.store.get(PATH)).toMatchObject({ quantity: 10, rate: 100, amount: 1000 })
    expect(f.store.get(PATH).quantApplied).toBeUndefined()
    expect(calls.staged).toBe(0)
  })

  it('refuses a unit or cost-code change underneath (legacy stamps) and a quantity edit underneath', async () => {
    for (const change of [{ unit: 'm3' }, { costCodeId: 'cc9' }, { quantity: 11, amount: 935 }]) {
      const f = fakeFirestore()
      f.store.set(PATH, stored({ ...change, updatedAt: null }))
      const { stageLock } = lockSpy()
      await expectKind(runApplyBoqQuantity({ ...f, itemRef: f.ref(PATH), seen: seen({ updatedAt: null }), quantity: 12, measurementCount: 1, evidence: EV, uid: 'u1', stageLock }), BOQ_WRITE_ERROR.STALE)
      expect(f.store.get(PATH).quantApplied).toBeUndefined()
    }
  })

  it('refuses when the quantity already equals the server quantity (idempotent — set, never add)', async () => {
    const f = fakeFirestore()
    f.store.set(PATH, stored({ quantity: 12, amount: 1020 }))
    const { stageLock } = lockSpy()
    await expectKind(runApplyBoqQuantity({ ...f, itemRef: f.ref(PATH), seen: seen({ quantity: 12, amount: 1020 }), quantity: 12, measurementCount: 1, evidence: EV, uid: 'u1', stageLock }), BOQ_WRITE_ERROR.INVALID, /already equals/)
    expect(f.store.get(PATH).quantApplied).toBeUndefined()
  })

  it('applying twice does not accumulate: the second apply with the same total is refused, a different total replaces', async () => {
    const f = fakeFirestore()
    f.store.set(PATH, stored())
    const { stageLock } = lockSpy()
    await runApplyBoqQuantity({ ...f, itemRef: f.ref(PATH), seen: seen(), quantity: 12, measurementCount: 1, evidence: EV, uid: 'u1', stageLock })
    const after = { id: 'b1', ...f.store.get(PATH) }
    await expectKind(runApplyBoqQuantity({ ...f, itemRef: f.ref(PATH), seen: after, quantity: 12, measurementCount: 1, evidence: EV, uid: 'u1', stageLock }), BOQ_WRITE_ERROR.INVALID)
    expect(f.store.get(PATH).quantity).toBe(12)
    await runApplyBoqQuantity({ ...f, itemRef: f.ref(PATH), seen: after, quantity: 24, measurementCount: 2, evidence: EV, uid: 'u2', stageLock })
    expect(f.store.get(PATH)).toMatchObject({ quantity: 24, amount: 2040, quantApplied: { by: 'u2', quantity: 24, measurementCount: 2 } })
  })

  it('refuses a missing item, a void item, an unusable quantity or count, and a missing actor — before any read when possible', async () => {
    const f = fakeFirestore()
    const { stageLock } = lockSpy()
    const base = { ...f, itemRef: f.ref(PATH), seen: seen(), uid: 'u1', stageLock }
    await expectKind(runApplyBoqQuantity({ ...base, quantity: 12, measurementCount: 1, evidence: EV }), BOQ_WRITE_ERROR.MISSING)
    await expectKind(runApplyBoqQuantity({ ...base, seen: seen({ status: 'void' }), quantity: 12, measurementCount: 1, evidence: EV }), BOQ_WRITE_ERROR.INVALID)
    await expectKind(runApplyBoqQuantity({ ...base, quantity: NaN, measurementCount: 1, evidence: EV }), BOQ_WRITE_ERROR.INVALID, /usable quantity/)
    await expectKind(runApplyBoqQuantity({ ...base, quantity: -1, measurementCount: 1, evidence: EV }), BOQ_WRITE_ERROR.INVALID)
    await expectKind(runApplyBoqQuantity({ ...base, quantity: '12', measurementCount: 1, evidence: EV }), BOQ_WRITE_ERROR.INVALID)
    await expectKind(runApplyBoqQuantity({ ...base, quantity: 12, measurementCount: 0, evidence: EV }), BOQ_WRITE_ERROR.INVALID, /eligible measurement/)
    await expectKind(runApplyBoqQuantity({ ...base, quantity: 12, measurementCount: 1.5, evidence: EV }), BOQ_WRITE_ERROR.INVALID)
    await expectKind(runApplyBoqQuantity({ ...base, uid: null, quantity: 12, measurementCount: 1, evidence: EV }), BOQ_WRITE_ERROR.PERMISSION)
    f.store.set(PATH, stored({ status: 'void' }))
    await expectKind(runApplyBoqQuantity({ ...base, quantity: 12, measurementCount: 1, evidence: EV }), BOQ_WRITE_ERROR.INVALID)
    expect(f.store.get(PATH).quantity).toBe(10)
  })

  it('requires a bounded evidence fingerprint — missing, blank, oversized or non-string is refused before any write', async () => {
    const f = fakeFirestore()
    f.store.set(PATH, stored())
    const { stageLock, calls } = lockSpy()
    const base = { ...f, itemRef: f.ref(PATH), seen: seen(), uid: 'u1', stageLock, quantity: 12, measurementCount: 1 }
    for (const evidence of [undefined, null, '', 'x'.repeat(129), 42, { hash: 'v1:abc' }]) {
      await expectKind(runApplyBoqQuantity({ ...base, evidence }), BOQ_WRITE_ERROR.INVALID, /fingerprinted/)
    }
    expect(f.store.get(PATH).quantity).toBe(10)
    expect(f.store.get(PATH).quantApplied).toBeUndefined()
    expect(calls.staged).toBe(0)
    await runApplyBoqQuantity({ ...base, evidence: 'x'.repeat(128) })
    expect(f.store.get(PATH).quantApplied.evidence).toBe('x'.repeat(128))
  })

  it('a zero total is a legitimate quantity (nothing measured yet still a measurement)', async () => {
    const f = fakeFirestore()
    f.store.set(PATH, stored())
    const { stageLock } = lockSpy()
    await runApplyBoqQuantity({ ...f, itemRef: f.ref(PATH), seen: seen(), quantity: 0, measurementCount: 1, evidence: EV, uid: 'u1', stageLock })
    expect(f.store.get(PATH)).toMatchObject({ quantity: 0, amount: 0 })
  })
})
