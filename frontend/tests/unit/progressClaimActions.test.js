import { describe, it, expect } from 'vitest'
import {
  runUpdateClaimDraft, runTransitionClaim, draftUpdate, transitionUpdate, normaliseApprovedAmounts,
  storedRevision, nextRevision, ClaimWriteError, CLAIM_WRITE_ERROR, CLAIM_WRITE_ERROR_MESSAGES, claimWriteErrorKind,
} from '../../src/lib/progressClaimActions'
import { CLAIM_STATUS, CLAIM_TRANSITION_STAMPS, CLAIM_TRANSITIONS, claimTotals } from '../../src/lib/progressClaims'

// ── Guarded claim writes — pure contract over a FAKE transaction (ADR-58) ────
//
// The emulator suite (tests/rules/progressClaims.rules.test.js) runs the real
// transactions against the real rules. This file pins the module's contract
// without Firestore: the exact update each write carries, the order of its
// checks, the stale test and the error kinds — through an injected transaction
// whose reads are scripted.

const NOW = Symbol('serverTimestamp()')
const serverTimestamp = () => NOW

function fakeDb(docs) {
  const writes = []
  const tx = {
    get: async (ref) => ({ exists: () => docs[ref] !== undefined, id: ref, data: () => docs[ref] }),
    update: (ref, data) => writes.push({ ref, data }),
  }
  const runTransaction = async (_db, body) => body(tx)
  return { runTransaction, writes }
}

const line = (o = {}) => ({
  poLineIndex: 0, costCodeId: 'cc1', costCodeName: '03-100 — Concrete', description: 'Slab',
  poLineTotal: 10000, previouslyApproved: 2000, claimedToDate: 5000, claimedThisPeriod: 3000, approvedThisPeriod: null, ...o,
})
const claim = (o = {}) => ({
  id: 'c1', claimNumber: 'PC-0007', status: CLAIM_STATUS.DRAFT, poId: 'po1', revision: 1,
  lineItems: [line(), line({ poLineIndex: 1, costCodeId: 'cc2', previouslyApproved: 0, claimedToDate: 0, claimedThisPeriod: 0 })],
  retention: 300, claimedSubtotal: 3000, claimedGst: 270, claimedTotal: 2970,
  ...o,
})
const base = (overrides = {}) => ({ db: {}, claimRef: 'c1', uid: 'u_qs', serverTimestamp, ...overrides })
const edit = { periodEnding: '2026-02-28', claimRef: ' S-2 ', notes: undefined, retention: '500', claimedToDate: ['8000', '1000'] }

async function expectKind(promise, kind) {
  let caught
  try { await promise } catch (e) { caught = e }
  expect(caught).toBeInstanceOf(ClaimWriteError)
  expect(caught.kind).toBe(kind)
  return caught
}

describe('revision arithmetic', () => {
  it('reads a numeric stored revision, and a missing / malformed one as 0 — exactly as the rules read it', () => {
    expect(storedRevision({ revision: 1 })).toBe(1)
    expect(storedRevision({ revision: 7 })).toBe(7)
    expect(storedRevision({})).toBe(0)
    expect(storedRevision(null)).toBe(0)
    expect(storedRevision({ revision: 'x' })).toBe(0)
    expect(nextRevision({ revision: 1 })).toBe(2)
    expect(nextRevision({})).toBe(1)
  })
})

describe('draftUpdate — the exact draft-edit write', () => {
  it('contains ONLY the draft-editable fields, the derived header, revision + 1 and the audit stamps', () => {
    const payload = draftUpdate(claim(), edit, 'u_qs', NOW)
    expect(Object.keys(payload).sort()).toEqual(
      ['claimRef', 'claimedGst', 'claimedSubtotal', 'claimedTotal', 'lineItems', 'notes', 'periodEnding', 'retention', 'revision', 'updatedAt', 'updatedBy'].sort()
    )
    expect(payload).toMatchObject({ claimRef: 'S-2', notes: '', periodEnding: '2026-02-28', revision: 2, updatedAt: NOW, updatedBy: 'u_qs' })
    expect(payload.lineItems.map(l => l.claimedThisPeriod)).toEqual([6000, 1000])
    expect(payload).toMatchObject({ claimedSubtotal: 7000, retention: 500, claimedGst: 650, claimedTotal: 7150 })
    for (const k of ['status', 'poId', 'claimNumber', 'approvedSubtotal', 'assessmentNotes', 'submittedAt', 'createdBy']) expect(k in payload).toBe(false)
  })

  it('rebuilds every line over the STORED line — identity preserved, approvedThisPeriod forced null', () => {
    const stored = claim({ lineItems: [line({ approvedThisPeriod: 999 })] })
    const payload = draftUpdate(stored, { ...edit, claimedToDate: ['5000'] }, 'u_qs', NOW)
    expect(payload.lineItems[0]).toEqual({ ...line(), claimedToDate: 5000, claimedThisPeriod: 3000, approvedThisPeriod: null })
  })

  it('refuses a count mismatch, a line below previously approved, nothing claimed, and a negative retention — as INVALID with the readable reason', () => {
    expect(() => draftUpdate(claim(), { ...edit, claimedToDate: ['8000'] }, 'u_qs', NOW)).toThrow(/claimed-to-date value is required for every claim line/)
    expect(() => draftUpdate(claim(), { ...edit, claimedToDate: ['1000', '0'] }, 'u_qs', NOW)).toThrow(/below the previously approved/)
    expect(() => draftUpdate(claim(), { ...edit, claimedToDate: ['2000', '0'] }, 'u_qs', NOW)).toThrow(/at least one line/)
    expect(() => draftUpdate(claim(), { ...edit, retention: '-1' }, 'u_qs', NOW)).toThrow(/cannot be negative/)
    try { draftUpdate(claim(), { ...edit, retention: 'abc' }, 'u_qs', NOW) } catch (e) {
      expect(e).toBeInstanceOf(ClaimWriteError)
      expect(e.kind).toBe(CLAIM_WRITE_ERROR.INVALID)
      expect(e.message).toBe('Retention must be a number')
    }
  })

  it('a legacy copy with no revision writes revision 1', () => {
    const { revision: _r, ...legacy } = claim()   // eslint-disable-line no-unused-vars
    expect(draftUpdate(legacy, edit, 'u_qs', NOW).revision).toBe(1)
  })
})

describe('transitionUpdate — the exact transition writes', () => {
  it('submit and reject write status, the (at, by) pair, revision + 1 and the audit stamps — nothing else', () => {
    expect(transitionUpdate(claim(), CLAIM_STATUS.SUBMITTED, {}, 'u1', NOW))
      .toEqual({ status: 'submitted', submittedAt: NOW, submittedBy: 'u1', revision: 2, updatedAt: NOW, updatedBy: 'u1' })
    expect(transitionUpdate(claim({ status: 'submitted', revision: 2 }), CLAIM_STATUS.REJECTED, {}, 'u1', NOW))
      .toEqual({ status: 'rejected', rejectedAt: NOW, rejectedBy: 'u1', revision: 3, updatedAt: NOW, updatedBy: 'u1' })
  })

  it('reject carries the assessment notes only when given (trimmed); blank notes are omitted', () => {
    expect(transitionUpdate(claim(), CLAIM_STATUS.REJECTED, { assessmentNotes: '  Not due  ' }, 'u1', NOW).assessmentNotes).toBe('Not due')
    expect('assessmentNotes' in transitionUpdate(claim(), CLAIM_STATUS.REJECTED, { assessmentNotes: '   ' }, 'u1', NOW)).toBe(false)
  })

  it('approve writes the certified lines (identity carried, amounts in cents), the approved header over the STORED retention, the notes and the stamps', () => {
    const live = claim({ status: 'submitted' })
    const payload = transitionUpdate(live, CLAIM_STATUS.APPROVED, { approvedAmounts: ['2499.999', 0], assessmentNotes: ' Minor defects ' }, 'u_pm', NOW)
    expect(Object.keys(payload).sort()).toEqual(
      ['status', 'lineItems', 'approvedSubtotal', 'approvedGst', 'approvedTotal', 'assessmentNotes', 'approvedAt', 'approvedBy', 'revision', 'updatedAt', 'updatedBy'].sort()
    )
    expect(payload.lineItems[0]).toEqual({ ...line(), approvedThisPeriod: 2500 })
    expect(payload.lineItems[1].approvedThisPeriod).toBe(0)
    // claimTotals([2500, 0], 300): retained 300, net 2200, gst 220, total 2420
    expect(payload).toMatchObject({ approvedSubtotal: 2500, approvedGst: 220, approvedTotal: 2420, assessmentNotes: 'Minor defects', approvedAt: NOW, approvedBy: 'u_pm', revision: 2 })
    expect(payload).toEqual(expect.not.objectContaining({ retention: expect.anything() }))
    expect(payload).toEqual(expect.not.objectContaining({ claimedSubtotal: expect.anything() }))
  })

  it('approve clamps the stored retention to the certified subtotal, never rewriting it', () => {
    const payload = transitionUpdate(claim({ status: 'submitted' }), CLAIM_STATUS.APPROVED, { approvedAmounts: [200, 0] }, 'u_pm', NOW)
    expect(payload).toMatchObject(claimTotals([200, 0], 300) && { approvedSubtotal: 200, approvedGst: 0, approvedTotal: 0 })
    expect('retention' in payload).toBe(false)
  })

  it('approve refuses invalid certified amounts — count, negative, above claimed, non-numeric — as INVALID, and the reserved targets as INVALID', () => {
    const live = claim({ status: 'submitted' })
    for (const approvedAmounts of [[3000], [-1, 0], [3000.01, 0], null]) {
      expect(() => transitionUpdate(live, CLAIM_STATUS.APPROVED, { approvedAmounts }, 'u_pm', NOW)).toThrow(ClaimWriteError)
    }
    // Rubbish is normalised to 0 BEFORE validation — exactly what the assess
    // modal hands the hook (`Number(a) || 0`) — so it certifies nothing.
    expect(transitionUpdate(live, CLAIM_STATUS.APPROVED, { approvedAmounts: ['abc', 0] }, 'u_pm', NOW).approvedSubtotal).toBe(0)
    expect(() => transitionUpdate(live, CLAIM_STATUS.UNDER_REVIEW, {}, 'u_pm', NOW)).toThrow(/reserved/)
    expect(() => transitionUpdate(claim({ status: 'approved' }), CLAIM_STATUS.INVOICED, {}, 'u_pm', NOW)).toThrow(/reserved/)
    expect(() => transitionUpdate(live, CLAIM_STATUS.DRAFT, {}, 'u_pm', NOW)).toThrow(/reserved/)
  })

  it('normaliseApprovedAmounts rounds to cents and treats blanks / rubbish as 0; CLAIM_TRANSITION_STAMPS covers exactly the three application targets', () => {
    expect(normaliseApprovedAmounts(['10.005', '', null, 'x', 2.345])).toEqual([10.01, 0, 0, 0, 2.35])
    expect(normaliseApprovedAmounts(null)).toEqual([])
    expect(Object.keys(CLAIM_TRANSITION_STAMPS).sort()).toEqual(['approved', 'rejected', 'submitted'])
    // Every reachable target in CLAIM_TRANSITIONS is either stamped or reserved.
    const targets = new Set(Object.values(CLAIM_TRANSITIONS).flat())
    for (const t of targets) expect(t in CLAIM_TRANSITION_STAMPS || ['under_review', 'invoiced'].includes(t)).toBe(true)
  })
})

describe('runUpdateClaimDraft — checks, stale detection and the write', () => {
  it('no uid → PERMISSION; no seen id → MISSING; a non-draft copy / invalid data → INVALID; nothing read or written', async () => {
    const { runTransaction, writes } = fakeDb({ c1: claim() })
    await expectKind(runUpdateClaimDraft(base({ runTransaction, uid: null, seen: claim(), data: edit })), CLAIM_WRITE_ERROR.PERMISSION)
    await expectKind(runUpdateClaimDraft(base({ runTransaction, seen: {}, data: edit })), CLAIM_WRITE_ERROR.MISSING)
    await expectKind(runUpdateClaimDraft(base({ runTransaction, seen: claim({ status: 'submitted' }), data: edit })), CLAIM_WRITE_ERROR.INVALID)
    await expectKind(runUpdateClaimDraft(base({ runTransaction, seen: claim(), data: { ...edit, claimedToDate: ['1'] } })), CLAIM_WRITE_ERROR.INVALID)
    expect(writes).toEqual([])
  })

  it('writes the draft update built over the SERVER copy', async () => {
    const { runTransaction, writes } = fakeDb({ c1: claim() })
    const out = await runUpdateClaimDraft(base({ runTransaction, seen: claim(), data: edit }))
    expect(out).toEqual({ kind: null })
    expect(writes).toHaveLength(1)
    expect(writes[0].data).toEqual(draftUpdate(claim(), edit, 'u_qs', NOW))
  })

  it('a server copy at another revision → STALE with nothing written (the other editor’s save stands)', async () => {
    const { runTransaction, writes } = fakeDb({ c1: claim({ revision: 2, claimedSubtotal: 1200 }) })
    const err = await expectKind(runUpdateClaimDraft(base({ runTransaction, seen: claim(), data: edit })), CLAIM_WRITE_ERROR.STALE)
    expect(err.message).toMatch(/changed by another user/)
    expect(err.message).toMatch(/your entries are kept/)
    expect(writes).toEqual([])
  })

  it('a server copy no longer draft → STALE naming the new status; a vanished document → MISSING', async () => {
    const { runTransaction, writes } = fakeDb({ c1: claim({ status: 'submitted' }) })
    const err = await expectKind(runUpdateClaimDraft(base({ runTransaction, seen: claim(), data: edit })), CLAIM_WRITE_ERROR.STALE)
    expect(err.message).toMatch(/PC-0007 is now Submitted, not Draft/)
    const gone = fakeDb({})
    await expectKind(runUpdateClaimDraft(base({ runTransaction: gone.runTransaction, seen: claim(), data: edit })), CLAIM_WRITE_ERROR.MISSING)
    expect(writes).toEqual([])
  })

  it('a legacy copy with no revision is handled: seen and live both read 0, the write carries 1', async () => {
    const { revision: _r, ...legacy } = claim()   // eslint-disable-line no-unused-vars
    const { runTransaction, writes } = fakeDb({ c1: legacy })
    await runUpdateClaimDraft(base({ runTransaction, seen: legacy, data: edit }))
    expect(writes[0].data.revision).toBe(1)
  })

  it('maps a thrown Firestore error to its kind and preserves the cause', async () => {
    for (const [code, kind] of [['permission-denied', 'permission'], ['unavailable', 'offline'], ['deadline-exceeded', 'offline'], ['not-found', 'missing'], ['internal', 'unknown'], [undefined, 'unknown']]) {
      const runTransaction = async () => { const e = new Error('boom'); e.code = code; throw e }
      const err = await expectKind(runUpdateClaimDraft(base({ runTransaction, seen: claim(), data: edit })), kind)
      expect(err.cause?.message).toBe('boom')
      expect(err.message).toBe(CLAIM_WRITE_ERROR_MESSAGES[kind])
      expect(claimWriteErrorKind(code)).toBe(kind)
    }
  })
})

describe('runTransitionClaim — checks, stale detection and the write', () => {
  it('no uid → PERMISSION; no seen id → MISSING; illegal move / reserved target / bad amounts → INVALID; nothing read or written', async () => {
    const { runTransaction, writes } = fakeDb({ c1: claim() })
    await expectKind(runTransitionClaim(base({ runTransaction, uid: null, seen: claim(), nextStatus: CLAIM_STATUS.SUBMITTED })), CLAIM_WRITE_ERROR.PERMISSION)
    await expectKind(runTransitionClaim(base({ runTransaction, seen: {}, nextStatus: CLAIM_STATUS.SUBMITTED })), CLAIM_WRITE_ERROR.MISSING)
    await expectKind(runTransitionClaim(base({ runTransaction, seen: claim(), nextStatus: CLAIM_STATUS.APPROVED, extras: { approvedAmounts: [3000, 0] } })), CLAIM_WRITE_ERROR.INVALID)
    await expectKind(runTransitionClaim(base({ runTransaction, seen: claim({ status: 'submitted' }), nextStatus: CLAIM_STATUS.UNDER_REVIEW })), CLAIM_WRITE_ERROR.INVALID)
    await expectKind(runTransitionClaim(base({ runTransaction, seen: claim({ status: 'approved' }), nextStatus: CLAIM_STATUS.INVOICED })), CLAIM_WRITE_ERROR.INVALID)
    await expectKind(runTransitionClaim(base({ runTransaction, seen: claim({ status: 'submitted' }), nextStatus: CLAIM_STATUS.APPROVED, extras: { approvedAmounts: [3001, 0] } })), CLAIM_WRITE_ERROR.INVALID)
    await expectKind(runTransitionClaim(base({ runTransaction, seen: claim({ status: 'rejected' }), nextStatus: CLAIM_STATUS.SUBMITTED })), CLAIM_WRITE_ERROR.INVALID)
    expect(writes).toEqual([])
  })

  it('submit from the reviewed copy writes exactly the submit update', async () => {
    const { runTransaction, writes } = fakeDb({ c1: claim() })
    await runTransitionClaim(base({ runTransaction, seen: claim(), nextStatus: CLAIM_STATUS.SUBMITTED }))
    expect(writes).toEqual([{ ref: 'c1', data: { status: 'submitted', submittedAt: NOW, submittedBy: 'u_qs', revision: 2, updatedAt: NOW, updatedBy: 'u_qs' } }])
  })

  it('approve validates the amounts against the SERVER lines and writes the approve update built over the server copy', async () => {
    const live = claim({ status: 'submitted', revision: 2 })
    const { runTransaction, writes } = fakeDb({ c1: live })
    await runTransitionClaim(base({ runTransaction, uid: 'u_pm', seen: live, nextStatus: CLAIM_STATUS.APPROVED, extras: { approvedAmounts: [2500, 0], assessmentNotes: 'ok' } }))
    expect(writes[0].data).toEqual(transitionUpdate(live, CLAIM_STATUS.APPROVED, { approvedAmounts: [2500, 0], assessmentNotes: 'ok' }, 'u_pm', NOW))
    expect(writes[0].data.revision).toBe(3)
  })

  it('a STALE copy (status moved underneath) → STALE naming the new status; a revision moved → STALE; nothing written', async () => {
    const approvedUnderneath = fakeDb({ c1: claim({ status: 'approved', revision: 3 }) })
    const err = await expectKind(runTransitionClaim(base({ runTransaction: approvedUnderneath.runTransaction, seen: claim({ status: 'submitted', revision: 2 }), nextStatus: CLAIM_STATUS.REJECTED })), CLAIM_WRITE_ERROR.STALE)
    expect(err.message).toMatch(/now Approved, not Submitted/)
    const editedUnderneath = fakeDb({ c1: claim({ revision: 2 }) })
    await expectKind(runTransitionClaim(base({ runTransaction: editedUnderneath.runTransaction, seen: claim(), nextStatus: CLAIM_STATUS.SUBMITTED })), CLAIM_WRITE_ERROR.STALE)
    expect(approvedUnderneath.writes).toEqual([])
    expect(editedUnderneath.writes).toEqual([])
  })

  it('a vanished document → MISSING; a thrown permission error → PERMISSION', async () => {
    const gone = fakeDb({})
    await expectKind(runTransitionClaim(base({ runTransaction: gone.runTransaction, seen: claim(), nextStatus: CLAIM_STATUS.SUBMITTED })), CLAIM_WRITE_ERROR.MISSING)
    const runTransaction = async () => { const e = new Error('denied'); e.code = 'permission-denied'; throw e }
    await expectKind(runTransitionClaim(base({ runTransaction, seen: claim(), nextStatus: CLAIM_STATUS.SUBMITTED })), CLAIM_WRITE_ERROR.PERMISSION)
  })

  it('the error class carries a default message per kind, and a ClaimWriteError thrown inside the transaction passes through unchanged', async () => {
    expect(new ClaimWriteError(CLAIM_WRITE_ERROR.STALE).message).toBe(CLAIM_WRITE_ERROR_MESSAGES.stale)
    expect(new ClaimWriteError('nonsense').message).toBe(CLAIM_WRITE_ERROR_MESSAGES.unknown)
    expect(new ClaimWriteError(CLAIM_WRITE_ERROR.INVALID, 'custom').message).toBe('custom')
    const inner = new ClaimWriteError(CLAIM_WRITE_ERROR.BLOCKED ?? 'invalid', 'inner')
    const runTransaction = async () => { throw inner }
    let caught
    try { await runTransitionClaim(base({ runTransaction, seen: claim(), nextStatus: CLAIM_STATUS.SUBMITTED })) } catch (e) { caught = e }
    expect(caught).toBe(inner)
  })
})
