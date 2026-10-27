import { describe, it, expect } from 'vitest'
import {
  runUpdateVariationDraft, runTransitionVariation, draftUpdate, transitionUpdate, todayIso,
  storedRevision, nextRevision, VariationWriteError, VARIATION_WRITE_ERROR, VARIATION_WRITE_ERROR_MESSAGES, variationWriteErrorKind,
} from '../../src/lib/variationActions'
import {
  VARIATION_STATUS, VARIATION_TYPE, VARIATION_TRANSITION_STAMPS, VARIATION_TRANSITIONS, TAX_CODE, gstForLine,
} from '../../src/lib/variations'

// ── Guarded variation writes — pure contract over a FAKE transaction (ADR-59) ─
//
// The emulator suite (tests/rules/variations.rules.test.js) runs the real
// transactions against the real rules. This file pins the module's contract
// without Firestore: the exact update each write carries, the order of its
// checks, the stale test and the error kinds — through an injected transaction
// whose reads are scripted.

const NOW = Symbol('serverTimestamp()')
const serverTimestamp = () => NOW
const TODAY = '2026-10-27'

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
  costCodeId: 'cc1', costCodeName: '03-100 — Concrete', description: 'Extra steel',
  submittedAmount: 1000, submittedGst: 100, approvedAmount: null, approvedGst: null, poLineIndex: null, taxCode: TAX_CODE.GST, ...o,
})
const variation = (o = {}) => ({
  id: 'v1', variationNumber: 'SV-0007', variationType: VARIATION_TYPE.SUPPLIER, status: VARIATION_STATUS.DRAFT, revision: 1,
  title: 'Additional steel', submittedDate: '', approvedDate: '', effectiveDate: '',
  lineItems: [line(), line({ costCodeId: 'cc2', submittedAmount: -200, submittedGst: 0, taxCode: TAX_CODE.GST_FREE })],
  submittedSubtotal: 800, submittedGst: 100, submittedTotal: 900,
  ...o,
})
const base = (overrides = {}) => ({ db: {}, variationRef: 'v1', uid: 'u_qs', serverTimestamp, today: TODAY, ...overrides })
const edit = {
  title: '  Additional steel (revised) ', description: ' More ', reason: 'site_condition',
  clientRef: 'IGNORED', supplierRef: ' Q-9 ',
  identifiedDate: '2026-10-01', responseDueDate: '', effectiveDate: '2026-11-01',
  lineItems: [line({ submittedAmount: 1500, submittedGst: 150, approvedAmount: 999, approvedGst: 99 })],
  notes: undefined,
}

async function expectKind(promise, kind) {
  let caught
  try { await promise } catch (e) { caught = e }
  expect(caught).toBeInstanceOf(VariationWriteError)
  expect(caught.kind).toBe(kind)
  return caught
}

describe('revision arithmetic and today', () => {
  it('reads a numeric stored revision, and a missing / malformed one as 0 — exactly as the rules read it', () => {
    expect(storedRevision({ revision: 1 })).toBe(1)
    expect(storedRevision({ revision: 7 })).toBe(7)
    expect(storedRevision({})).toBe(0)
    expect(storedRevision(null)).toBe(0)
    expect(storedRevision({ revision: 'x' })).toBe(0)
    expect(nextRevision({ revision: 1 })).toBe(2)
    expect(nextRevision({})).toBe(1)
  })

  it('todayIso renders the local calendar day as YYYY-MM-DD', () => {
    expect(todayIso(new Date(2026, 0, 5))).toBe('2026-01-05')
    expect(todayIso()).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})

describe('draftUpdate — the exact draft-edit write', () => {
  it('contains ONLY the draft-editable fields, the derived submitted header, revision + 1 and the audit stamps (notes omitted when undefined)', () => {
    const payload = draftUpdate(variation(), edit, 'u_qs', NOW)
    expect(Object.keys(payload).sort()).toEqual(
      ['title', 'description', 'reason', 'clientRef', 'supplierRef', 'identifiedDate', 'responseDueDate', 'effectiveDate',
        'lineItems', 'submittedSubtotal', 'submittedGst', 'submittedTotal', 'revision', 'updatedAt', 'updatedBy'].sort()
    )
    expect(payload).toMatchObject({
      title: 'Additional steel (revised)', description: 'More', reason: 'site_condition',
      clientRef: null, supplierRef: 'Q-9',
      identifiedDate: '2026-10-01', responseDueDate: '', effectiveDate: '2026-11-01',
      submittedSubtotal: 1500, submittedGst: 150, submittedTotal: 1650,
      revision: 2, updatedAt: NOW, updatedBy: 'u_qs',
    })
    for (const k of ['status', 'poId', 'variationNumber', 'variationType', 'approvedSubtotal', 'assessmentNotes', 'submittedAt', 'submittedDate', 'createdBy', 'originRfiId', 'notes']) {
      expect(k in payload).toBe(false)
    }
  })

  it('forces the approved side of every line null and re-derives the header from the SIGNED lines', () => {
    const payload = draftUpdate(variation(), { ...edit, lineItems: [line({ submittedAmount: 1000, submittedGst: 100, approvedAmount: 5, approvedGst: 1 }), line({ submittedAmount: -1500, submittedGst: -150, approvedAmount: 2 })] }, 'u_qs', NOW)
    expect(payload.lineItems.map(l => [l.approvedAmount, l.approvedGst])).toEqual([[null, null], [null, null]])
    expect(payload).toMatchObject({ submittedSubtotal: -500, submittedGst: -50, submittedTotal: -550 })
  })

  it('the external reference lands on the SERVER copy’s type — a client draft keeps clientRef and nulls supplierRef', () => {
    const payload = draftUpdate(variation({ variationType: VARIATION_TYPE.CLIENT }), { ...edit, clientRef: ' VO-12 ' }, 'u_qs', NOW)
    expect(payload).toMatchObject({ clientRef: 'VO-12', supplierRef: null })
  })

  it('writes notes only when given (trimmed) and the originating-RFI triple only when passed (null unlinks)', () => {
    const withNotes = draftUpdate(variation(), { ...edit, notes: '  n  ' }, 'u_qs', NOW)
    expect(withNotes.notes).toBe('n')
    const unlink = draftUpdate(variation(), { ...edit, originRfi: null }, 'u_qs', NOW)
    expect(unlink).toMatchObject({ originRfiId: null, originRfiNumber: null, originRfiTitle: null })
    const rfi = { id: 'r1', rfiNumber: 'RFI-0001', title: 'Steel', status: 'open' }
    expect(draftUpdate(variation(), { ...edit, originRfi: rfi }, 'u_qs', NOW)).toMatchObject({ originRfiId: 'r1', originRfiNumber: 'RFI-0001', originRfiTitle: 'Steel' })
  })

  it('refuses a missing title, no lines, more than 200 lines, a line without a cost code and an ineligible RFI — as INVALID with the readable reason', () => {
    expect(() => draftUpdate(variation(), { ...edit, title: '  ' }, 'u_qs', NOW)).toThrow(/Title is required/)
    expect(() => draftUpdate(variation(), { ...edit, lineItems: [] }, 'u_qs', NOW)).toThrow(/At least one line item/)
    expect(() => draftUpdate(variation(), { ...edit, lineItems: Array.from({ length: 201 }, () => line()) }, 'u_qs', NOW)).toThrow(/at most 200/)
    expect(() => draftUpdate(variation(), { ...edit, lineItems: [line({ costCodeId: '' })] }, 'u_qs', NOW)).toThrow(/Line 1: a cost code is required/)
    try { draftUpdate(variation(), { ...edit, originRfi: { id: 'r', rfiNumber: 'RFI-0002', title: 't', status: 'draft' } }, 'u_qs', NOW) } catch (e) {
      expect(e).toBeInstanceOf(VariationWriteError)
      expect(e.kind).toBe(VARIATION_WRITE_ERROR.INVALID)
      expect(e.message).toMatch(/Only open, answered or closed RFIs/)
    }
  })

  it('a legacy copy with no revision writes revision 1', () => {
    const { revision: _r, ...legacy } = variation()   // eslint-disable-line no-unused-vars
    expect(draftUpdate(legacy, edit, 'u_qs', NOW).revision).toBe(1)
  })
})

describe('transitionUpdate — the exact transition writes', () => {
  it('submit writes status, the (at, by) pair, the submitted date (today when unset, kept when set), revision + 1 and the audit stamps — nothing else', () => {
    expect(transitionUpdate(variation(), VARIATION_STATUS.SUBMITTED, {}, 'u1', NOW, TODAY))
      .toEqual({ status: 'submitted', submittedAt: NOW, submittedBy: 'u1', submittedDate: TODAY, revision: 2, updatedAt: NOW, updatedBy: 'u1' })
    expect(transitionUpdate(variation({ submittedDate: '2026-09-01' }), VARIATION_STATUS.SUBMITTED, {}, 'u1', NOW, TODAY).submittedDate).toBe('2026-09-01')
  })

  it('reject and withdraw write status, the pair, revision + 1 and the stamps; reject carries the notes only when given', () => {
    expect(transitionUpdate(variation({ status: 'submitted', revision: 2 }), VARIATION_STATUS.REJECTED, {}, 'u1', NOW, TODAY))
      .toEqual({ status: 'rejected', rejectedAt: NOW, rejectedBy: 'u1', revision: 3, updatedAt: NOW, updatedBy: 'u1' })
    expect(transitionUpdate(variation({ status: 'submitted' }), VARIATION_STATUS.REJECTED, { assessmentNotes: '  Not agreed  ' }, 'u1', NOW, TODAY).assessmentNotes).toBe('Not agreed')
    expect('assessmentNotes' in transitionUpdate(variation({ status: 'submitted' }), VARIATION_STATUS.REJECTED, { assessmentNotes: '   ' }, 'u1', NOW, TODAY)).toBe(false)
    expect(transitionUpdate(variation(), VARIATION_STATUS.WITHDRAWN, {}, 'u1', NOW, TODAY))
      .toEqual({ status: 'withdrawn', withdrawnAt: NOW, withdrawnBy: 'u1', revision: 2, updatedAt: NOW, updatedBy: 'u1' })
  })

  it('approve writes the certified lines (identity and tax code carried, SIGNED amounts in cents, GST per line), the signed header, the notes, the dates and the stamps', () => {
    const live = variation({ status: 'submitted', revision: 2 })
    const payload = transitionUpdate(live, VARIATION_STATUS.APPROVED, { approvedAmounts: ['899.999', -250], assessmentNotes: ' Negotiated ' }, 'u_pm', NOW, TODAY)
    expect(Object.keys(payload).sort()).toEqual(
      ['status', 'lineItems', 'approvedSubtotal', 'approvedGst', 'approvedTotal', 'assessmentNotes', 'approvedDate', 'effectiveDate', 'approvedAt', 'approvedBy', 'revision', 'updatedAt', 'updatedBy'].sort()
    )
    expect(payload.lineItems[0]).toEqual({ ...live.lineItems[0], approvedAmount: 900, approvedGst: 90 })
    expect(payload.lineItems[1]).toEqual({ ...live.lineItems[1], approvedAmount: -250, approvedGst: 0 })   // gst_free → 0
    expect(payload).toMatchObject({
      approvedSubtotal: 650, approvedGst: 90, approvedTotal: 740, assessmentNotes: 'Negotiated',
      approvedDate: TODAY, effectiveDate: TODAY, approvedAt: NOW, approvedBy: 'u_pm', revision: 3,
    })
    expect(payload).toEqual(expect.not.objectContaining({ submittedSubtotal: expect.anything() }))
  })

  it('approve keeps an existing effective date, and falls back to the stored approved date before today', () => {
    expect(transitionUpdate(variation({ status: 'submitted', effectiveDate: '2026-12-01' }), VARIATION_STATUS.APPROVED, { approvedAmounts: [1000, -200] }, 'u', NOW, TODAY).effectiveDate).toBe('2026-12-01')
    const p = transitionUpdate(variation({ status: 'submitted', approvedDate: '2026-10-20' }), VARIATION_STATUS.APPROVED, { approvedAmounts: [1000, -200] }, 'u', NOW, TODAY)
    expect(p.approvedDate).toBe('2026-10-20')
    expect(p.effectiveDate).toBe('2026-10-20')
  })

  it('approve is UNBOUNDED against submitted (above, zero, negative are valid) but refuses a count mismatch, a non-number and differing amounts without notes — as INVALID; the reserved targets are INVALID', () => {
    const live = variation({ status: 'submitted' })
    expect(transitionUpdate(live, VARIATION_STATUS.APPROVED, { approvedAmounts: [5000, -9000], assessmentNotes: 'why' }, 'u', NOW, TODAY).approvedSubtotal).toBe(-4000)
    expect(transitionUpdate(live, VARIATION_STATUS.APPROVED, { approvedAmounts: [0, 0], assessmentNotes: 'nil' }, 'u', NOW, TODAY).approvedTotal).toBe(0)
    expect(() => transitionUpdate(live, VARIATION_STATUS.APPROVED, { approvedAmounts: [1000] }, 'u', NOW, TODAY)).toThrow(/an amount for every variation line/)
    expect(() => transitionUpdate(live, VARIATION_STATUS.APPROVED, { approvedAmounts: [1000, 'abc'] }, 'u', NOW, TODAY)).toThrow(/must be a number/)
    expect(() => transitionUpdate(live, VARIATION_STATUS.APPROVED, { approvedAmounts: [900, -200], assessmentNotes: '' }, 'u', NOW, TODAY)).toThrow(/Assessment notes are required/)
    expect(() => transitionUpdate(live, VARIATION_STATUS.UNDER_REVIEW, {}, 'u', NOW, TODAY)).toThrow(/reserved/)
    expect(() => transitionUpdate(live, VARIATION_STATUS.DISPUTED, {}, 'u', NOW, TODAY)).toThrow(/reserved/)
    expect(() => transitionUpdate(live, VARIATION_STATUS.SUPERSEDED, {}, 'u', NOW, TODAY)).toThrow(/reserved/)
    expect(() => transitionUpdate(live, VARIATION_STATUS.DRAFT, {}, 'u', NOW, TODAY)).toThrow(/reserved/)
  })

  it('VARIATION_TRANSITION_STAMPS covers exactly the four application targets; every reachable target in VARIATION_TRANSITIONS is stamped', () => {
    expect(Object.keys(VARIATION_TRANSITION_STAMPS).sort()).toEqual(['approved', 'rejected', 'submitted', 'withdrawn'])
    const targets = new Set(Object.values(VARIATION_TRANSITIONS).flat())
    for (const t of targets) expect(t in VARIATION_TRANSITION_STAMPS).toBe(true)
    expect(gstForLine(-250, TAX_CODE.GST_FREE)).toBe(0)
  })
})

describe('runUpdateVariationDraft — checks, stale detection and the write', () => {
  it('no uid → PERMISSION; no seen id → MISSING; a non-draft copy / invalid data → INVALID; nothing read or written', async () => {
    const { runTransaction, writes } = fakeDb({ v1: variation() })
    await expectKind(runUpdateVariationDraft(base({ runTransaction, uid: null, seen: variation(), data: edit })), VARIATION_WRITE_ERROR.PERMISSION)
    await expectKind(runUpdateVariationDraft(base({ runTransaction, seen: {}, data: edit })), VARIATION_WRITE_ERROR.MISSING)
    await expectKind(runUpdateVariationDraft(base({ runTransaction, seen: variation({ status: 'submitted' }), data: edit })), VARIATION_WRITE_ERROR.INVALID)
    await expectKind(runUpdateVariationDraft(base({ runTransaction, seen: variation(), data: { ...edit, title: '' } })), VARIATION_WRITE_ERROR.INVALID)
    expect(writes).toEqual([])
  })

  it('writes the draft update built over the SERVER copy (its type and revision)', async () => {
    const live = variation({ variationType: VARIATION_TYPE.CLIENT, revision: 4 })
    const { runTransaction, writes } = fakeDb({ v1: live })
    const out = await runUpdateVariationDraft(base({ runTransaction, seen: live, data: edit }))
    expect(out).toEqual({ kind: null })
    expect(writes).toHaveLength(1)
    expect(writes[0].data).toEqual(draftUpdate(live, edit, 'u_qs', NOW))
    expect(writes[0].data).toMatchObject({ revision: 5, clientRef: 'IGNORED', supplierRef: null })
  })

  it('a server copy at another revision → STALE with nothing written (the other editor’s save stands)', async () => {
    const { runTransaction, writes } = fakeDb({ v1: variation({ revision: 2, title: 'Theirs' }) })
    const err = await expectKind(runUpdateVariationDraft(base({ runTransaction, seen: variation(), data: edit })), VARIATION_WRITE_ERROR.STALE)
    expect(err.message).toMatch(/changed by another user/)
    expect(err.message).toMatch(/your entries are kept/)
    expect(writes).toEqual([])
  })

  it('a server copy no longer draft → STALE naming the new status; a vanished document → MISSING', async () => {
    const { runTransaction, writes } = fakeDb({ v1: variation({ status: 'submitted' }) })
    const err = await expectKind(runUpdateVariationDraft(base({ runTransaction, seen: variation(), data: edit })), VARIATION_WRITE_ERROR.STALE)
    expect(err.message).toMatch(/SV-0007 is now Submitted, not Draft/)
    const gone = fakeDb({})
    await expectKind(runUpdateVariationDraft(base({ runTransaction: gone.runTransaction, seen: variation(), data: edit })), VARIATION_WRITE_ERROR.MISSING)
    expect(writes).toEqual([])
  })

  it('a legacy copy with no revision is handled: seen and live both read 0, the write carries 1', async () => {
    const { revision: _r, ...legacy } = variation()   // eslint-disable-line no-unused-vars
    const { runTransaction, writes } = fakeDb({ v1: legacy })
    await runUpdateVariationDraft(base({ runTransaction, seen: legacy, data: edit }))
    expect(writes[0].data.revision).toBe(1)
  })

  it('maps a thrown Firestore error to its kind and preserves the cause', async () => {
    for (const [code, kind] of [['permission-denied', 'permission'], ['unavailable', 'offline'], ['deadline-exceeded', 'offline'], ['not-found', 'missing'], ['internal', 'unknown'], [undefined, 'unknown']]) {
      const runTransaction = async () => { const e = new Error('boom'); e.code = code; throw e }
      const err = await expectKind(runUpdateVariationDraft(base({ runTransaction, seen: variation(), data: edit })), kind)
      expect(err.cause?.message).toBe('boom')
      expect(err.message).toBe(VARIATION_WRITE_ERROR_MESSAGES[kind])
      expect(variationWriteErrorKind(code)).toBe(kind)
    }
  })
})

describe('runTransitionVariation — checks, stale detection and the write', () => {
  it('no uid → PERMISSION; no seen id → MISSING; illegal move / reserved target / bad amounts → INVALID; nothing read or written', async () => {
    const { runTransaction, writes } = fakeDb({ v1: variation() })
    await expectKind(runTransitionVariation(base({ runTransaction, uid: null, seen: variation(), nextStatus: VARIATION_STATUS.SUBMITTED })), VARIATION_WRITE_ERROR.PERMISSION)
    await expectKind(runTransitionVariation(base({ runTransaction, seen: {}, nextStatus: VARIATION_STATUS.SUBMITTED })), VARIATION_WRITE_ERROR.MISSING)
    await expectKind(runTransitionVariation(base({ runTransaction, seen: variation(), nextStatus: VARIATION_STATUS.APPROVED, extras: { approvedAmounts: [1000, -200] } })), VARIATION_WRITE_ERROR.INVALID)   // draft → approved
    await expectKind(runTransitionVariation(base({ runTransaction, seen: variation(), nextStatus: VARIATION_STATUS.REJECTED })), VARIATION_WRITE_ERROR.INVALID)                                          // draft → rejected
    await expectKind(runTransitionVariation(base({ runTransaction, seen: variation({ status: 'submitted' }), nextStatus: VARIATION_STATUS.UNDER_REVIEW })), VARIATION_WRITE_ERROR.INVALID)
    await expectKind(runTransitionVariation(base({ runTransaction, seen: variation({ status: 'submitted' }), nextStatus: VARIATION_STATUS.APPROVED, extras: { approvedAmounts: [1000] } })), VARIATION_WRITE_ERROR.INVALID)
    await expectKind(runTransitionVariation(base({ runTransaction, seen: variation({ status: 'approved' }), nextStatus: VARIATION_STATUS.WITHDRAWN })), VARIATION_WRITE_ERROR.INVALID)
    await expectKind(runTransitionVariation(base({ runTransaction, seen: variation({ status: 'rejected' }), nextStatus: VARIATION_STATUS.SUBMITTED })), VARIATION_WRITE_ERROR.INVALID)
    await expectKind(runTransitionVariation(base({ runTransaction, seen: variation({ status: 'withdrawn' }), nextStatus: VARIATION_STATUS.DRAFT })), VARIATION_WRITE_ERROR.INVALID)
    expect(writes).toEqual([])
  })

  it('submit and withdraw from the reviewed copy write exactly the transition update', async () => {
    const { runTransaction, writes } = fakeDb({ v1: variation() })
    await runTransitionVariation(base({ runTransaction, seen: variation(), nextStatus: VARIATION_STATUS.SUBMITTED }))
    expect(writes).toEqual([{ ref: 'v1', data: { status: 'submitted', submittedAt: NOW, submittedBy: 'u_qs', submittedDate: TODAY, revision: 2, updatedAt: NOW, updatedBy: 'u_qs' } }])
    const w = fakeDb({ v1: variation({ status: 'submitted', revision: 2 }) })
    await runTransitionVariation(base({ runTransaction: w.runTransaction, seen: variation({ status: 'submitted', revision: 2 }), nextStatus: VARIATION_STATUS.WITHDRAWN }))
    expect(w.writes[0].data).toEqual({ status: 'withdrawn', withdrawnAt: NOW, withdrawnBy: 'u_qs', revision: 3, updatedAt: NOW, updatedBy: 'u_qs' })
  })

  it('approve validates the amounts against the SERVER lines and writes the approve update built over the server copy', async () => {
    const live = variation({ status: 'submitted', revision: 2 })
    const { runTransaction, writes } = fakeDb({ v1: live })
    await runTransitionVariation(base({ runTransaction, uid: 'u_pm', seen: live, nextStatus: VARIATION_STATUS.APPROVED, extras: { approvedAmounts: [900, -200], assessmentNotes: 'ok' } }))
    expect(writes[0].data).toEqual(transitionUpdate(live, VARIATION_STATUS.APPROVED, { approvedAmounts: [900, -200], assessmentNotes: 'ok' }, 'u_pm', NOW, TODAY))
    expect(writes[0].data.revision).toBe(3)
  })

  it('a STALE copy (status moved underneath) → STALE naming the new status; a revision moved → STALE; nothing written', async () => {
    const approvedUnderneath = fakeDb({ v1: variation({ status: 'approved', revision: 3 }) })
    const err = await expectKind(runTransitionVariation(base({ runTransaction: approvedUnderneath.runTransaction, seen: variation({ status: 'submitted', revision: 2 }), nextStatus: VARIATION_STATUS.REJECTED })), VARIATION_WRITE_ERROR.STALE)
    expect(err.message).toMatch(/now Approved, not Submitted/)
    const editedUnderneath = fakeDb({ v1: variation({ revision: 2 }) })
    await expectKind(runTransitionVariation(base({ runTransaction: editedUnderneath.runTransaction, seen: variation(), nextStatus: VARIATION_STATUS.SUBMITTED })), VARIATION_WRITE_ERROR.STALE)
    expect(approvedUnderneath.writes).toEqual([])
    expect(editedUnderneath.writes).toEqual([])
  })

  it('a vanished document → MISSING; a thrown permission error → PERMISSION; a VariationWriteError thrown inside passes through unchanged', async () => {
    const gone = fakeDb({})
    await expectKind(runTransitionVariation(base({ runTransaction: gone.runTransaction, seen: variation(), nextStatus: VARIATION_STATUS.SUBMITTED })), VARIATION_WRITE_ERROR.MISSING)
    const denied = async () => { const e = new Error('denied'); e.code = 'permission-denied'; throw e }
    await expectKind(runTransitionVariation(base({ runTransaction: denied, seen: variation(), nextStatus: VARIATION_STATUS.SUBMITTED })), VARIATION_WRITE_ERROR.PERMISSION)
    const inner = new VariationWriteError(VARIATION_WRITE_ERROR.INVALID, 'inner')
    let caught
    try { await runTransitionVariation(base({ runTransaction: async () => { throw inner }, seen: variation(), nextStatus: VARIATION_STATUS.SUBMITTED })) } catch (e) { caught = e }
    expect(caught).toBe(inner)
    expect(new VariationWriteError(VARIATION_WRITE_ERROR.STALE).message).toBe(VARIATION_WRITE_ERROR_MESSAGES.stale)
    expect(new VariationWriteError('nonsense').message).toBe(VARIATION_WRITE_ERROR_MESSAGES.unknown)
  })
})
