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

// ── M3-B1 (ADR-62): commitment application in the approve write, and the legacy Apply ──

import {
  runApplyVariationCommitment, applyCommitmentUpdate, commitmentStamps, scopeStamps,
} from '../../src/lib/variationActions'
import { VARIATION_COMMITMENT_KEYS, SCOPE_COMMITMENT_KEYS } from '../../src/lib/variations'

const PO_SENT = { id: 'po1', poNumber: 'PO-0001', status: 'sent', lineItems: [{ costCodeId: 'cc1', lineTotal: 100_000 }] }
const PO_CANCELLED = { ...PO_SENT, status: 'cancelled' }
const linked = (o = {}) => variation({
  status: VARIATION_STATUS.SUBMITTED, poId: 'po1', poNumber: 'PO-0001',
  lineItems: [line({ poLineIndex: 0 }), line({ costCodeId: 'cc2', submittedAmount: -200, submittedGst: 0, taxCode: TAX_CODE.GST_FREE })],
  ...o,
})
const approveExtras = { approvedAmounts: [1000, -200], assessmentNotes: '' }

describe('transitionUpdate — approve with / without the commitment stamps', () => {
  it('applyCommitment: true adds exactly the FOUR stamps — the ADR-62 applied pair and the ADR-63 scope pair (actor, server time) — to the approve write; false adds nothing', () => {
    const live = linked()
    const withStamps = transitionUpdate(live, VARIATION_STATUS.APPROVED, { ...approveExtras, applyCommitment: true }, 'u_qs', NOW, TODAY)
    const without = transitionUpdate(live, VARIATION_STATUS.APPROVED, approveExtras, 'u_qs', NOW, TODAY)
    expect(withStamps.commitmentAppliedAt).toBe(NOW)
    expect(withStamps.commitmentAppliedBy).toBe('u_qs')
    expect(withStamps.scopeCommittedAt).toBe(NOW)
    expect(withStamps.scopeCommittedBy).toBe('u_qs')
    const ALL_KEYS = [...VARIATION_COMMITMENT_KEYS, ...SCOPE_COMMITMENT_KEYS]
    for (const k of ALL_KEYS) expect(without).not.toHaveProperty(k)
    const strip = (o) => { const c = { ...o }; for (const k of ALL_KEYS) delete c[k]; return c }
    expect(strip(withStamps)).toEqual(without)   // approved money, lines, notes, dates identical either way
    expect(commitmentStamps('u', NOW)).toEqual({ commitmentAppliedAt: NOW, commitmentAppliedBy: 'u' })
    expect(scopeStamps('u', NOW)).toEqual({ scopeCommittedAt: NOW, scopeCommittedBy: 'u' })
  })

  it('applyCommitment on a manual-mode supplier or a client variation is refused as INVALID', () => {
    expect(() => transitionUpdate(linked({ poId: null, poNumber: null }), VARIATION_STATUS.APPROVED, { ...approveExtras, applyCommitment: true }, 'u', NOW, TODAY))
      .toThrow(/names a purchase order/)
    expect(() => transitionUpdate(linked({ variationType: VARIATION_TYPE.CLIENT }), VARIATION_STATUS.APPROVED, { ...approveExtras, applyCommitment: true }, 'u', NOW, TODAY))
      .toThrow(/names a purchase order/)
  })

  it('submit, reject and withdraw never carry the stamps, whatever is passed', () => {
    for (const next of [VARIATION_STATUS.SUBMITTED, VARIATION_STATUS.REJECTED, VARIATION_STATUS.WITHDRAWN]) {
      const live = next === VARIATION_STATUS.SUBMITTED ? linked({ status: 'draft' }) : linked()
      const w = transitionUpdate(live, next, { applyCommitment: true }, 'u', NOW, TODAY)
      for (const k of VARIATION_COMMITMENT_KEYS) expect(w, next).not.toHaveProperty(k)
    }
  })
})

describe('runTransitionVariation — the approve-time decision over the SERVER copy of the PO', () => {
  it('a PO-linked supplier variation whose PO is sent on the server is approved AND applied in one write', async () => {
    const live = linked()
    const { runTransaction, writes } = fakeDb({ v1: live, po1: PO_SENT })
    const out = await runTransitionVariation(base({ runTransaction, poRef: 'po1', seen: live, nextStatus: VARIATION_STATUS.APPROVED, extras: approveExtras }))
    expect(out).toEqual({ kind: null, commitmentApplied: true })
    expect(writes).toHaveLength(1)
    expect(writes[0].data).toMatchObject({ status: 'approved', commitmentAppliedAt: NOW, commitmentAppliedBy: 'u_qs', revision: 2 })
  })

  it('a closed PO applies too', async () => {
    const live = linked()
    const { runTransaction, writes } = fakeDb({ v1: live, po1: { ...PO_SENT, status: 'closed' } })
    const out = await runTransitionVariation(base({ runTransaction, poRef: 'po1', seen: live, nextStatus: VARIATION_STATUS.APPROVED, extras: approveExtras }))
    expect(out.commitmentApplied).toBe(true)
    expect(writes[0].data.commitmentAppliedBy).toBe('u_qs')
  })

  it('Correction A — a cancelled, draft, pending or MISSING PO on the server REFUSES the approval (PO_INVALID) with nothing written and a specific, actionable message', async () => {
    for (const po of [PO_CANCELLED, { ...PO_SENT, status: 'draft' }, { ...PO_SENT, status: 'pending_approval' }, undefined]) {
      const live = linked()
      const docs = { v1: live }
      if (po) docs.po1 = po
      const { runTransaction, writes } = fakeDb(docs)
      const err = await expectKind(runTransitionVariation(base({ runTransaction, poRef: 'po1', seen: live, nextStatus: VARIATION_STATUS.APPROVED, extras: approveExtras })), VARIATION_WRITE_ERROR.PO_INVALID)
      expect(err.message, String(po?.status)).toMatch(po ? /is (Cancelled|Draft|Pending Approval); a supplier variation can only be approved while its purchase order is sent or closed/ : /could not be found in this project/)
      expect(err.message).toMatch(/Withdraw or reject/)
      expect(writes).toHaveLength(0)
    }
  })

  it('Correction A — a PO-linked supplier approve with NO poRef is refused BEFORE any read (never an unapplied fallback)', async () => {
    const reads = []
    const live = linked()
    const tx = { get: async (ref) => { reads.push(ref); return { exists: () => true, id: ref, data: () => live } }, update: () => {} }
    await expectKind(runTransitionVariation(base({ runTransaction: async (_d, body) => body(tx), seen: live, nextStatus: VARIATION_STATUS.APPROVED, extras: approveExtras })), VARIATION_WRITE_ERROR.PO_INVALID)
    expect(reads).toEqual([])
  })

  it('a stale PO (sent when reviewed, cancelled on the server) is decided on the SERVER copy — refused, nothing written', async () => {
    const live = linked()
    const { runTransaction, writes } = fakeDb({ v1: live, po1: PO_CANCELLED })
    await expectKind(runTransitionVariation(base({ runTransaction, poRef: 'po1', seen: { ...live }, nextStatus: VARIATION_STATUS.APPROVED, extras: approveExtras })), VARIATION_WRITE_ERROR.PO_INVALID)
    expect(writes).toHaveLength(0)
  })

  it('manual-mode and client variations keep their lifecycle: approved without reading a PO, without stamps', async () => {
    for (const live of [linked({ poId: null, poNumber: null }), linked({ variationType: VARIATION_TYPE.CLIENT, poId: null, poNumber: null })]) {
      const reads = []
      const tx = { get: async (ref) => { reads.push(ref); return { exists: () => true, id: ref, data: () => live } }, update: () => {} }
      const out = await runTransitionVariation(base({ runTransaction: async (_d, body) => body(tx), seen: live, nextStatus: VARIATION_STATUS.APPROVED, extras: approveExtras }))
      expect(reads).toEqual(['v1'])
      expect(out.commitmentApplied).toBe(false)
    }
  })

  it('a manual-mode supplier variation with a poRef supplied by mistake reads no PO and applies nothing', async () => {
    const reads = []
    const live = linked({ poId: null, poNumber: null })
    const tx = { get: async (ref) => { reads.push(ref); return { exists: () => true, id: ref, data: () => (ref === 'v1' ? live : PO_SENT) } }, update: () => {} }
    const out = await runTransitionVariation(base({ runTransaction: async (_d, body) => body(tx), poRef: 'po1', seen: live, nextStatus: VARIATION_STATUS.APPROVED, extras: approveExtras }))
    expect(reads).toEqual(['v1'])
    expect(out.commitmentApplied).toBe(false)
  })
})

describe('runApplyVariationCommitment — the one-time legacy Apply', () => {
  const approvedLinked = (o = {}) => linked({
    status: VARIATION_STATUS.APPROVED, revision: 2,
    lineItems: [line({ poLineIndex: 0, approvedAmount: 1000, approvedGst: 100 })], approvedSubtotal: 1000, approvedGst: 100, approvedTotal: 1100,
    ...o,
  })

  const BOTH_PAIRS = { commitmentAppliedAt: NOW, commitmentAppliedBy: 'u_pm', scopeCommittedAt: NOW, scopeCommittedBy: 'u_pm' }

  it('applyCommitmentUpdate writes exactly the MISSING pair(s) + revision + audit stamps — a present pair is never rewritten (ADR-63)', () => {
    // Nothing applied: both pairs.
    expect(applyCommitmentUpdate({ revision: 2 }, 'u_pm', NOW)).toEqual({ ...BOTH_PAIRS, revision: 3, updatedAt: NOW, updatedBy: 'u_pm' })
    expect(applyCommitmentUpdate({}, 'u', NOW).revision).toBe(1)
    // Applied under M3-B1: the scope pair only; the applied pair is untouched.
    expect(applyCommitmentUpdate({ revision: 3, commitmentAppliedAt: 'earlier', commitmentAppliedBy: 'u_x' }, 'u_pm', NOW)).toEqual({
      scopeCommittedAt: NOW, scopeCommittedBy: 'u_pm', revision: 4, updatedAt: NOW, updatedBy: 'u_pm',
    })
    // Scope committed without the applied pair (not a shape the app writes, but never overwritten either).
    expect(applyCommitmentUpdate({ revision: 3, scopeCommittedAt: 'earlier', scopeCommittedBy: 'u_x' }, 'u_pm', NOW)).toEqual({
      commitmentAppliedAt: NOW, commitmentAppliedBy: 'u_pm', revision: 4, updatedAt: NOW, updatedBy: 'u_pm',
    })
  })

  it('refuses BEFORE any read: no uid, no id, no poRef, not approved, manual mode, client, already applied (both pairs, or applied with no positive new scope)', async () => {
    const seen = approvedLinked()
    const { runTransaction, writes } = fakeDb({ v1: seen, po1: PO_SENT })
    const run = (over) => runApplyVariationCommitment(base({ runTransaction, poRef: 'po1', seen, ...over }))
    await expectKind(run({ uid: null }), VARIATION_WRITE_ERROR.PERMISSION)
    await expectKind(run({ seen: {} }), VARIATION_WRITE_ERROR.MISSING)
    await expectKind(run({ poRef: null }), VARIATION_WRITE_ERROR.INVALID)
    await expectKind(run({ seen: approvedLinked({ status: 'submitted' }) }), VARIATION_WRITE_ERROR.INVALID)
    await expectKind(run({ seen: approvedLinked({ status: 'rejected' }) }), VARIATION_WRITE_ERROR.INVALID)
    await expectKind(run({ seen: approvedLinked({ poId: null, poNumber: null }) }), VARIATION_WRITE_ERROR.INVALID)
    await expectKind(run({ seen: approvedLinked({ variationType: VARIATION_TYPE.CLIENT }) }), VARIATION_WRITE_ERROR.INVALID)
    await expectKind(run({ seen: approvedLinked({ ...BOTH_PAIRS }) }), VARIATION_WRITE_ERROR.ALREADY_APPLIED)
    // Applied under M3-B1 with existing-line amounts only: there is no new scope to commit.
    await expectKind(run({ seen: approvedLinked({ commitmentAppliedAt: NOW, commitmentAppliedBy: 'u_x' }) }), VARIATION_WRITE_ERROR.ALREADY_APPLIED)
    expect(writes).toHaveLength(0)
  })

  it('writes BOTH pairs once over the reviewed copy when the server PO is sent or closed (nothing applied before)', async () => {
    for (const status of ['sent', 'closed']) {
      const seen = approvedLinked()
      const { runTransaction, writes } = fakeDb({ v1: seen, po1: { ...PO_SENT, status } })
      const out = await runApplyVariationCommitment(base({ runTransaction, poRef: 'po1', seen, uid: 'u_pm' }))
      expect(out).toEqual({ kind: null, applied: true, scopeCommitted: true })
      expect(writes).toEqual([{ ref: 'v1', data: { ...BOTH_PAIRS, revision: 3, updatedAt: NOW, updatedBy: 'u_pm' } }])
    }
  })

  it('ADR-63 — a variation applied under M3-B1 with a positive new-scope line takes the SCOPE pair only ("Commit new scope"); the applied pair is untouched', async () => {
    const seen = approvedLinked({
      revision: 3, commitmentAppliedAt: 'earlier', commitmentAppliedBy: 'u_x',
      lineItems: [line({ poLineIndex: 0, approvedAmount: 1000, approvedGst: 100 }), line({ poLineIndex: null, approvedAmount: 4000, approvedGst: 400, costCodeId: 'W' })],
    })
    const { runTransaction, writes } = fakeDb({ v1: seen, po1: PO_SENT })
    const out = await runApplyVariationCommitment(base({ runTransaction, poRef: 'po1', seen, uid: 'u_pm' }))
    expect(out).toEqual({ kind: null, applied: false, scopeCommitted: true })
    expect(writes).toEqual([{ ref: 'v1', data: { scopeCommittedAt: NOW, scopeCommittedBy: 'u_pm', revision: 4, updatedAt: NOW, updatedBy: 'u_pm' } }])
    // A NEGATIVE new-scope line alone is nothing to commit.
    const negative = approvedLinked({ commitmentAppliedAt: 'earlier', commitmentAppliedBy: 'u_x', lineItems: [line({ poLineIndex: null, approvedAmount: -3000, approvedGst: -300 })] })
    const neg = fakeDb({ v1: negative, po1: PO_SENT })
    await expectKind(runApplyVariationCommitment(base({ runTransaction: neg.runTransaction, poRef: 'po1', seen: negative })), VARIATION_WRITE_ERROR.ALREADY_APPLIED)
    expect(neg.writes).toHaveLength(0)
  })

  it('a SECOND apply (the server copy already carries both pairs) is refused as ALREADY_APPLIED with nothing written — before the stale check', async () => {
    const seen = approvedLinked()
    const { runTransaction, writes } = fakeDb({ v1: { ...seen, ...commitmentStamps('u_other', NOW), ...scopeStamps('u_other', NOW), revision: 3 }, po1: PO_SENT })
    await expectKind(runApplyVariationCommitment(base({ runTransaction, poRef: 'po1', seen })), VARIATION_WRITE_ERROR.ALREADY_APPLIED)
    expect(writes).toHaveLength(0)
  })

  it('a server copy that gained ONLY the applied pair underneath (an M3-B1 apply) is STALE for this reviewed copy — the revision moved; nothing written', async () => {
    const seen = approvedLinked()
    const { runTransaction, writes } = fakeDb({ v1: { ...seen, ...commitmentStamps('u_other', NOW), revision: 3 }, po1: PO_SENT })
    await expectKind(runApplyVariationCommitment(base({ runTransaction, poRef: 'po1', seen })), VARIATION_WRITE_ERROR.STALE)
    expect(writes).toHaveLength(0)
  })

  it('two concurrent applies from the same reviewed copy: the first wins, the second is refused, exactly one write lands', async () => {
    const seen = approvedLinked()
    const docs = { v1: { ...seen }, po1: PO_SENT }
    const writes = []
    // A fake Firestore that APPLIES each committed write to the document, so
    // the second transaction reads the first one's stamps.
    const runTransaction = async (_db, body) => {
      const tx = {
        get: async (ref) => ({ exists: () => docs[ref] !== undefined, id: ref, data: () => docs[ref] }),
        update: (ref, data) => { writes.push({ ref, data }); docs[ref] = { ...docs[ref], ...data } },
      }
      return body(tx)
    }
    const first = await runApplyVariationCommitment(base({ runTransaction, poRef: 'po1', seen, uid: 'u_a' }))
    const second = await expectKind(runApplyVariationCommitment(base({ runTransaction, poRef: 'po1', seen, uid: 'u_b' })), VARIATION_WRITE_ERROR.ALREADY_APPLIED)
    expect(first).toEqual({ kind: null, applied: true, scopeCommitted: true })
    expect(second.message).toMatch(/already been applied/)
    expect(writes).toHaveLength(1)
    expect(docs.v1.commitmentAppliedBy).toBe('u_a')
    expect(docs.v1.scopeCommittedBy).toBe('u_a')
  })

  it('a STALE copy (revision moved underneath) and a missing document are refused with nothing written', async () => {
    const seen = approvedLinked()
    const moved = fakeDb({ v1: { ...seen, revision: 5 }, po1: PO_SENT })
    const err = await expectKind(runApplyVariationCommitment(base({ runTransaction: moved.runTransaction, poRef: 'po1', seen })), VARIATION_WRITE_ERROR.STALE)
    expect(err.message).toMatch(/changed by another user/)
    expect(moved.writes).toHaveLength(0)
    const gone = fakeDb({ po1: PO_SENT })
    await expectKind(runApplyVariationCommitment(base({ runTransaction: gone.runTransaction, poRef: 'po1', seen })), VARIATION_WRITE_ERROR.MISSING)
  })

  it('a cancelled, draft or missing PO on the SERVER refuses the apply as INVALID, naming the reason', async () => {
    const seen = approvedLinked()
    for (const po of [PO_CANCELLED, { ...PO_SENT, status: 'draft' }, undefined]) {
      const docs = { v1: seen }
      if (po) docs.po1 = po
      const { runTransaction, writes } = fakeDb(docs)
      const err = await expectKind(runApplyVariationCommitment(base({ runTransaction, poRef: 'po1', seen })), VARIATION_WRITE_ERROR.INVALID)
      expect(err.message).toMatch(po ? /not sent or closed/ : /could not be found/)
      expect(writes).toHaveLength(0)
    }
  })

  it('a legacy document with no revision key applies at revision 1 and acquires the audit stamps', async () => {
    const legacy = approvedLinked()
    delete legacy.revision
    const { runTransaction, writes } = fakeDb({ v1: legacy, po1: PO_SENT })
    await runApplyVariationCommitment(base({ runTransaction, poRef: 'po1', seen: legacy }))
    expect(writes[0].data.revision).toBe(1)
  })

  it('maps SDK error codes exactly as the other transactions do', async () => {
    const seen = approvedLinked()
    for (const [code, kind] of [['permission-denied', VARIATION_WRITE_ERROR.PERMISSION], ['unavailable', VARIATION_WRITE_ERROR.OFFLINE], ['not-found', VARIATION_WRITE_ERROR.MISSING], ['weird', VARIATION_WRITE_ERROR.UNKNOWN]]) {
      const runTransaction = async () => { const e = new Error('boom'); e.code = code; throw e }
      await expectKind(runApplyVariationCommitment(base({ runTransaction, poRef: 'po1', seen })), kind)
    }
    expect(VARIATION_WRITE_ERROR_MESSAGES[VARIATION_WRITE_ERROR.ALREADY_APPLIED]).toMatch(/already been applied/)
  })
})
