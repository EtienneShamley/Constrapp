import { describe, it, expect } from 'vitest'
import {
  runUpdateVariationDraft, runTransitionVariation, transitionUpdate, todayIso,
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

// ADR-90: a draft edit is processed by the trusted backend. What the server
// DERIVES and stores is `buildVariationDraftUpdate` (tests/unit/
// variationProcessing.test.js); what it DECIDES — draft only, the reviewed
// revision, sources, replays, races — is proven against the real transactions
// in tests/functions/variations.test.js. This file pins what the BROWSER does:
// what it sends, what it refuses before calling, and how it reads the answer.
describe('runUpdateVariationDraft — the call', () => {
  const seen = variation({ revision: 3 })

  it('sends the REVIEWED revision and ONLY authored content — no GST, no totals, no cost-code name, no status, no stamp, no calculation version', async () => {
    const { call, calls } = fakeCall({ variationId: 'v1', alreadyApplied: false, calcVersion: 2 })
    const out = await runUpdateVariationDraft({ call, projectId: 'p1', seen, data: edit, uid: 'u_qs' })
    expect(out).toEqual({ variationId: 'v1', alreadyApplied: false, calcVersion: 2 })
    expect(calls).toHaveLength(1)
    const { name, data } = calls[0]
    expect(name).toBe(VARIATION_CALLABLE.UPDATE)
    expect(Object.keys(data).sort()).toEqual([...UPDATE_VARIATION_KEYS].sort())
    expect(data).toMatchObject({
      projectId: 'p1', variationId: 'v1', expectedRevision: 3,
      title: 'Additional steel (revised)', description: 'More', reason: 'site_condition',
      identifiedDate: '2026-10-01', responseDueDate: '', effectiveDate: '2026-11-01',
      // The external reference lands on the variation's OWN side; the other is null.
      supplierRef: 'Q-9', clientRef: null,
      // `notes` and `originRfi` were not passed: keep what is stored.
      notes: null, changeOriginRfi: false, originRfiId: null,
    })
    // The editor's built line carried a GST and certified values; none of it is sent.
    expect(data.lines).toEqual([{ poLineIndex: null, costCodeId: 'cc1', description: 'Extra steel', submittedAmount: 1500, taxCode: 'gst' }])
    expect(updateVariationRequestProblem(data)).toBeNull()
    expect(JSON.stringify(data)).not.toMatch(/submittedGst|approvedAmount|approvedGst|Subtotal|Total|costCodeName|status|updatedBy|calcVersion|variationNumber/)
  })

  it('a client draft sends clientRef and nulls supplierRef; notes are sent only when given (trimmed)', async () => {
    const { call, calls } = fakeCall({ variationId: 'v1', alreadyApplied: false, calcVersion: 2 })
    await runUpdateVariationDraft({ call, projectId: 'p1', seen: variation({ variationType: VARIATION_TYPE.CLIENT }), data: { ...edit, clientRef: ' CR-7 ', notes: '  keep this  ' }, uid: 'u' })
    expect(calls[0].data).toMatchObject({ clientRef: 'CR-7', supplierRef: null, notes: 'keep this' })
  })

  it('the originating RFI travels as an explicit change: undefined keeps the stored link, null removes it, an RFI sets it by id only', async () => {
    const send = async (originRfi) => {
      const { call, calls } = fakeCall({ variationId: 'v1', alreadyApplied: false, calcVersion: 2 })
      await runUpdateVariationDraft({ call, projectId: 'p1', seen, data: { ...edit, originRfi }, uid: 'u' })
      return calls[0].data
    }
    expect(await send(undefined)).toMatchObject({ changeOriginRfi: false, originRfiId: null })
    expect(await send(null)).toMatchObject({ changeOriginRfi: true, originRfiId: null })
    const set = await send({ id: 'rfi9', rfiNumber: 'RFI-0009', title: 'Slab', status: 'answered' })
    expect(set).toMatchObject({ changeOriginRfi: true, originRfiId: 'rfi9' })
    expect(JSON.stringify(set)).not.toMatch(/RFI-0009|Slab/)
  })

  it('a legacy copy with no revision sends revision 0', async () => {
    const { call, calls } = fakeCall({ variationId: 'v1', alreadyApplied: false, calcVersion: 2 })
    await runUpdateVariationDraft({ call, projectId: 'p1', seen: variation({ revision: undefined }), data: edit, uid: 'u' })
    expect(calls[0].data.expectedRevision).toBe(0)
  })

  it('refuses BEFORE any call: no uid, no id, a non-draft copy, a missing title, no lines, more than 200 lines, a line without a cost code, an ineligible RFI, an out-of-range amount', async () => {
    const { call, calls } = fakeCall({ variationId: 'v1', alreadyApplied: false, calcVersion: 2 })
    const run = (over) => runUpdateVariationDraft({ call, projectId: 'p1', seen, data: edit, uid: 'u', ...over })
    await expectKind(run({ uid: null }), VARIATION_WRITE_ERROR.PERMISSION)
    await expectKind(run({ seen: {} }), VARIATION_WRITE_ERROR.MISSING)
    for (const status of ['submitted', 'approved', 'rejected', 'withdrawn']) {
      expect((await expectKind(run({ seen: variation({ status }) }), VARIATION_WRITE_ERROR.INVALID)).message).toBe('Only draft variations can be edited')
    }
    expect((await expectKind(run({ data: { ...edit, title: '   ' } }), VARIATION_WRITE_ERROR.INVALID)).message).toBe('Title is required')
    await expectKind(run({ data: { ...edit, lineItems: [] } }), VARIATION_WRITE_ERROR.INVALID)
    await expectKind(run({ data: { ...edit, lineItems: Array.from({ length: 201 }, () => line()) } }), VARIATION_WRITE_ERROR.INVALID)
    await expectKind(run({ data: { ...edit, lineItems: [line({ costCodeId: '' })] } }), VARIATION_WRITE_ERROR.INVALID)
    expect((await expectKind(run({ data: { ...edit, originRfi: { id: 'r', rfiNumber: 'RFI-1', title: 't', status: 'draft' } } }), VARIATION_WRITE_ERROR.INVALID)).message).toMatch(/open, answered or closed/)
    await expectKind(run({ data: { ...edit, lineItems: [line({ submittedAmount: 1e15 })] } }), VARIATION_WRITE_ERROR.INVALID)
    await expectKind(run({ data: { ...edit, effectiveDate: '1/11/2026' } }), VARIATION_WRITE_ERROR.INVALID)
    expect(calls).toEqual([])
  })

  it('the server’s answers: a stale revision and "no longer a draft" are STALE (the editor keeps the entries); a repeat already saved is a RESULT; no answer is UNCERTAIN', async () => {
    const run = (answer) => runUpdateVariationDraft({ call: fakeCall(answer).call, projectId: 'p1', seen, data: edit, uid: 'u' })
    expect((await expectKind(run(typed('variation-stale')), VARIATION_WRITE_ERROR.STALE)).message).toBe(VARIATION_WRITE_ERROR_MESSAGES.stale)
    const notDraft = await expectKind(run(typed('variation-not-draft', 'This variation is no longer a draft, so it can no longer be edited. Nothing was changed. Review the latest version.')), VARIATION_WRITE_ERROR.STALE)
    expect(notDraft.message).toMatch(/no longer a draft/)
    await expectKind(run(typed('not-found')), VARIATION_WRITE_ERROR.MISSING)
    await expectKind(run(typed('variation-forbidden')), VARIATION_WRITE_ERROR.PERMISSION)
    await expectKind(run(typed('variation-cost-code-invalid')), VARIATION_WRITE_ERROR.INVALID)
    await expectKind(run(typed('variation-rfi-invalid')), VARIATION_WRITE_ERROR.INVALID)
    await expectKind(run(typed('variation-processing-disabled')), VARIATION_WRITE_ERROR.UNAVAILABLE)
    await expect(run({ variationId: 'v1', alreadyApplied: true, calcVersion: 2 })).resolves.toMatchObject({ alreadyApplied: true })
    for (const code of ['deadline-exceeded', 'unavailable', 'internal']) {
      expect((await expectKind(run(transport(code)), VARIATION_WRITE_ERROR.UNCERTAIN)).message).toMatch(/may or may not have been saved/)
    }
    await expectKind(run(transport('permission-denied')), VARIATION_WRITE_ERROR.PERMISSION)
  })
})

describe('runTransitionVariation — checks, stale detection and the write', () => {
  it('maps a thrown Firestore error code to its kind (the submit / reject / withdraw transaction)', () => {
    expect(variationWriteErrorKind('permission-denied')).toBe(VARIATION_WRITE_ERROR.PERMISSION)
    expect(variationWriteErrorKind('unavailable')).toBe(VARIATION_WRITE_ERROR.OFFLINE)
    expect(variationWriteErrorKind('deadline-exceeded')).toBe(VARIATION_WRITE_ERROR.OFFLINE)
    expect(variationWriteErrorKind('not-found')).toBe(VARIATION_WRITE_ERROR.MISSING)
    expect(variationWriteErrorKind('anything-else')).toBe(VARIATION_WRITE_ERROR.UNKNOWN)
  })

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

  // ADR-90: approval is processed by the trusted backend. What it writes is
  // still `transitionUpdate` (pinned above, and composed by the callable); what
  // the server decides is proven in tests/functions/variations.test.js.
  it('ADR-90 — approval is NOT a browser transaction: refused as INVALID before any read, whatever the status and amounts; nothing written', async () => {
    const live = variation({ status: 'submitted', revision: 2 })
    const { runTransaction, writes } = fakeDb({ v1: live })
    const err = await expectKind(
      runTransitionVariation(base({ runTransaction, uid: 'u_pm', seen: live, nextStatus: VARIATION_STATUS.APPROVED, extras: { approvedAmounts: [900, -200], assessmentNotes: 'ok' } })),
      VARIATION_WRITE_ERROR.INVALID,
    )
    expect(err.message).toMatch(/approved by the Constrap server/)
    let reads = 0
    const counting = async () => { reads += 1 }
    await expectKind(runTransitionVariation(base({ runTransaction: counting, seen: live, nextStatus: VARIATION_STATUS.APPROVED, extras: { approvedAmounts: [1000, -200] } })), VARIATION_WRITE_ERROR.INVALID)
    expect(reads).toBe(0)
    expect(writes).toEqual([])
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

import { applyCommitmentUpdate, commitmentStamps, scopeStamps } from '../../src/lib/variationActions'
import { VARIATION_COMMITMENT_KEYS, SCOPE_COMMITMENT_KEYS } from '../../src/lib/variations'

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

// ── ADR-90: the three server operations are CALLS ────────────────────────────
//
// The decision over the SERVER copy of the variation and its purchase order —
// sent / closed applies, a cancelled / draft / pending / missing order refuses
// the approval, manual-mode and client variations carry no stamps, a stale
// copy is refused, two concurrent applies land once — was proven here against
// a fake transaction while the browser made those writes. The browser no
// longer makes them: every one of those cases is now proven against the real
// transactions in tests/functions/variations.test.js. This file pins what the
// BROWSER still does: what it sends, what it refuses before calling, and how
// it reads the server's answer — including an answer it never received.

import {
  runCreateVariation, runApproveVariation, runApplyVariationCommitment, describeVariationCallFailure,
  VARIATION_CALLABLE, VARIATION_CALL_TIMEOUT_MS,
} from '../../src/lib/variationActions'
import {
  CREATE_VARIATION_KEYS, CREATE_VARIATION_LINE_KEYS, createVariationRequestProblem,
  UPDATE_VARIATION_KEYS, updateVariationRequestProblem,
} from '../../src/lib/variationProcessing'

function fakeCall(answer) {
  const calls = []
  const call = async (name, data) => {
    calls.push({ name, data })
    if (answer instanceof Error) throw answer
    return typeof answer === 'function' ? answer(name, data) : answer
  }
  return { call, calls }
}
const typed = (code, message = 'server message') => Object.assign(new Error(message), { code: 'functions/failed-precondition', details: { code } })
const transport = (code) => Object.assign(new Error('transport'), { code: `functions/${code}` })

describe('runApproveVariation — the call', () => {
  const seen = linked({ revision: 4 })

  it('sends identifiers, the REVIEWED revision, the certified amounts as numbers, trimmed notes and the approver’s day — never a GST figure, a total, a status or a stamp', async () => {
    const { call, calls } = fakeCall({ variationId: 'v1', alreadyApplied: false, commitmentApplied: true })
    const result = await runApproveVariation({ call, projectId: 'p1', seen, approvedAmounts: ['1000', -200], assessmentNotes: '  as agreed ', uid: 'u_pm', today: TODAY })
    expect(result).toEqual({ variationId: 'v1', alreadyApplied: false, commitmentApplied: true })
    expect(calls).toEqual([{
      name: VARIATION_CALLABLE.APPROVE,
      data: { projectId: 'p1', variationId: 'v1', expectedRevision: 4, approvedAmounts: [1000, -200], assessmentNotes: 'as agreed', approvedDate: TODAY },
    }])
    expect(VARIATION_CALLABLE).toEqual({ CREATE: 'createVariation', UPDATE: 'updateVariationDraft', APPROVE: 'approveVariation', APPLY: 'applyVariationCommitment' })
    expect(VARIATION_CALL_TIMEOUT_MS).toBeGreaterThan(60000)   // longer than the function may run
  })

  it('a blank amount is sent as 0; a legacy copy with no revision sends 0', async () => {
    const { call, calls } = fakeCall({ variationId: 'v1', alreadyApplied: false, commitmentApplied: false })
    const legacy = linked({ revision: undefined })
    await runApproveVariation({ call, projectId: 'p1', seen: legacy, approvedAmounts: ['', null], assessmentNotes: 'nil', uid: 'u', today: TODAY })
    expect(calls[0].data.approvedAmounts).toEqual([0, 0])
    expect(calls[0].data.expectedRevision).toBe(0)
  })

  it('refuses BEFORE any call: no uid, no id, a status that cannot be approved, a count mismatch, a non-number, differing amounts without notes', async () => {
    const { call, calls } = fakeCall({ variationId: 'v1', alreadyApplied: false, commitmentApplied: false })
    const run = (over) => runApproveVariation({ call, projectId: 'p1', seen, approvedAmounts: [1000, -200], assessmentNotes: '', uid: 'u', today: TODAY, ...over })
    await expectKind(run({ uid: null }), VARIATION_WRITE_ERROR.PERMISSION)
    await expectKind(run({ seen: {} }), VARIATION_WRITE_ERROR.MISSING)
    await expectKind(run({ seen: linked({ status: 'draft' }) }), VARIATION_WRITE_ERROR.INVALID)
    await expectKind(run({ seen: linked({ status: 'approved' }) }), VARIATION_WRITE_ERROR.INVALID)
    await expectKind(run({ approvedAmounts: [1000] }), VARIATION_WRITE_ERROR.INVALID)
    await expectKind(run({ approvedAmounts: [1000, 'abc'] }), VARIATION_WRITE_ERROR.INVALID)
    await expectKind(run({ approvedAmounts: [900, -200] }), VARIATION_WRITE_ERROR.INVALID)          // differs, no notes
    await expectKind(run({ approvedAmounts: [1e15, -200], assessmentNotes: 'x' }), VARIATION_WRITE_ERROR.INVALID)
    expect(calls).toEqual([])
  })

  it('a repeated approve the server already applied is a RESULT, not an error', async () => {
    const { call } = fakeCall({ variationId: 'v1', alreadyApplied: true, commitmentApplied: true })
    await expect(runApproveVariation({ call, projectId: 'p1', seen, ...approveExtras, uid: 'u', today: TODAY })).resolves.toEqual({ variationId: 'v1', alreadyApplied: true, commitmentApplied: true })
  })

  it('typed refusals map to their kind — the purchase-order refusal keeps the server’s specific, actionable message', async () => {
    const run = (err) => runApproveVariation({ call: fakeCall(err).call, projectId: 'p1', seen, ...approveExtras, uid: 'u', today: TODAY })
    const po = await expectKind(run(typed('variation-po-invalid', 'PO-0001 is not sent or closed; … Nothing was changed.')), VARIATION_WRITE_ERROR.PO_INVALID)
    expect(po.message).toBe('PO-0001 is not sent or closed; … Nothing was changed.')
    await expectKind(run(typed('variation-stale')), VARIATION_WRITE_ERROR.STALE)
    await expectKind(run(typed('variation-not-submitted')), VARIATION_WRITE_ERROR.STALE)
    await expectKind(run(typed('variation-forbidden')), VARIATION_WRITE_ERROR.PERMISSION)
    await expectKind(run(typed('membership-inactive')), VARIATION_WRITE_ERROR.PERMISSION)
    await expectKind(run(typed('no-membership')), VARIATION_WRITE_ERROR.PERMISSION)
    await expectKind(run(typed('not-found')), VARIATION_WRITE_ERROR.MISSING)
    await expectKind(run(typed('variation-figures-inconsistent')), VARIATION_WRITE_ERROR.INVALID)
    await expectKind(run(typed('variation-unsupported-record')), VARIATION_WRITE_ERROR.INVALID)
    await expectKind(run(typed('variation-amount-out-of-range')), VARIATION_WRITE_ERROR.INVALID)
    await expectKind(run(typed('variation-processing-disabled')), VARIATION_WRITE_ERROR.UNAVAILABLE)
    const busy = await expectKind(run(typed('variation-busy', 'This variation was being changed while the request ran. Nothing was changed. Try again.')), VARIATION_WRITE_ERROR.OFFLINE)
    expect(busy.message).toMatch(/Nothing was changed/)
    // The generic stale wording is the browser's own, and keeps the entries.
    expect((await expectKind(run(typed('variation-stale', 'server text')), VARIATION_WRITE_ERROR.STALE)).message).toBe(VARIATION_WRITE_ERROR_MESSAGES.stale)
  })

  it('an answer that never arrived is UNCERTAIN — never "nothing was saved"; a transport refusal before the handler is certain', async () => {
    const run = (err) => runApproveVariation({ call: fakeCall(err).call, projectId: 'p1', seen, ...approveExtras, uid: 'u', today: TODAY })
    for (const code of ['deadline-exceeded', 'unavailable', 'internal', 'cancelled', 'unknown']) {
      const err = await expectKind(run(transport(code)), VARIATION_WRITE_ERROR.UNCERTAIN)
      expect(err.message).toBe(VARIATION_WRITE_ERROR_MESSAGES.uncertain)
      expect(err.message).toMatch(/may or may not have been saved/)
      expect(err.message).not.toMatch(/nothing was saved/i)
    }
    await expectKind(run(new Error('no code at all')), VARIATION_WRITE_ERROR.UNCERTAIN)
    await expectKind(run(transport('unauthenticated')), VARIATION_WRITE_ERROR.PERMISSION)     // no ID token, or App Check refused
    await expectKind(run(transport('permission-denied')), VARIATION_WRITE_ERROR.PERMISSION)
    await expectKind(run(transport('not-found')), VARIATION_WRITE_ERROR.UNAVAILABLE)           // the function is not deployed
    await expectKind(run(transport('invalid-argument')), VARIATION_WRITE_ERROR.INVALID)
  })

  it('an answer that is not the operation’s own shape is UNCERTAIN; the original error is kept as the cause', async () => {
    for (const answer of [null, undefined, 'ok', {}, { alreadyApplied: 'no' }]) {
      await expectKind(runApproveVariation({ call: fakeCall(answer).call, projectId: 'p1', seen, ...approveExtras, uid: 'u', today: TODAY }), VARIATION_WRITE_ERROR.UNCERTAIN)
    }
    const source = typed('variation-stale')
    expect(describeVariationCallFailure(source).cause).toBe(source)
    const own = new VariationWriteError(VARIATION_WRITE_ERROR.INVALID, 'mine')
    expect(describeVariationCallFailure(own)).toBe(own)
  })

  it('nothing here retries: one call per attempt, whatever the outcome', async () => {
    const failing = fakeCall(transport('deadline-exceeded'))
    await expectKind(runApproveVariation({ call: failing.call, projectId: 'p1', seen, ...approveExtras, uid: 'u', today: TODAY }), VARIATION_WRITE_ERROR.UNCERTAIN)
    expect(failing.calls).toHaveLength(1)
  })
})

describe('runCreateVariation — the call', () => {
  const editorData = (o = {}) => ({
    variationType: VARIATION_TYPE.SUPPLIER,
    title: '  Additional steel ', description: ' More ', reason: 'site_condition',
    clientId: null, clientName: null, clientRef: null,
    supplierId: 'contactS1', supplierName: ' Steel Co ', supplierRef: ' Q-9 ',
    poId: null, poNumber: null,
    identifiedDate: '2026-10-01', submittedDate: '', responseDueDate: '', effectiveDate: '',
    lineItems: [line({ submittedAmount: 1500.5, submittedGst: 150.05 }), line({ costCodeId: 'cc2', submittedAmount: -200, submittedGst: 0, taxCode: TAX_CODE.GST_FREE })],
    notes: '',
    originRfi: null,
    ...o,
  })

  it('sends ONLY authored content: no GST, no totals, no number, no currency, no status, no cost-code name, no stamp', async () => {
    const { call, calls } = fakeCall({ variationId: 'newId', variationNumber: 'SV-0001', alreadyApplied: false })
    const result = await runCreateVariation({ call, projectId: 'p1', variationId: 'newId', data: editorData(), uid: 'u_qs' })
    expect(result.variationNumber).toBe('SV-0001')
    expect(calls).toHaveLength(1)
    const { name, data } = calls[0]
    expect(name).toBe(VARIATION_CALLABLE.CREATE)
    expect(Object.keys(data).sort()).toEqual([...CREATE_VARIATION_KEYS].sort())
    for (const l of data.lines) expect(Object.keys(l).sort()).toEqual([...CREATE_VARIATION_LINE_KEYS].sort())
    expect(data).toMatchObject({
      projectId: 'p1', variationId: 'newId', variationType: 'supplier',
      title: 'Additional steel', description: 'More', supplierId: 'contactS1', supplierName: 'Steel Co', supplierRef: 'Q-9',
      clientId: null, clientName: null, clientRef: null, poId: null, originRfiId: null,
    })
    expect(data.lines).toEqual([
      { poLineIndex: null, costCodeId: 'cc1', description: 'Extra steel', submittedAmount: 1500.5, taxCode: 'gst' },
      { poLineIndex: null, costCodeId: 'cc2', description: 'Extra steel', submittedAmount: -200, taxCode: 'gst_free' },
    ])
    expect(createVariationRequestProblem(data)).toBeNull()
    expect(JSON.stringify(data)).not.toMatch(/submittedGst|Subtotal|Total|costCodeName|currency|status|createdBy|calcVersion|variationNumber|poNumber/)
  })

  it('a PO-linked variation sends the purchase-order id and NO supplier — the server takes the supplier from the order; a PO line sends its index and no cost code', async () => {
    const { call, calls } = fakeCall({ variationId: 'x', variationNumber: 'SV-0002', alreadyApplied: false })
    await runCreateVariation({
      call, projectId: 'p1', variationId: 'x', uid: 'u',
      data: editorData({ poId: 'po1', poNumber: 'PO-0001', supplierId: 'forged', supplierName: 'Forged Pty', lineItems: [line({ poLineIndex: 0 }), line({ costCodeId: 'cc9' })] }),
    })
    expect(calls[0].data).toMatchObject({ poId: 'po1', supplierId: null, supplierName: null })
    expect(calls[0].data.lines[0]).toMatchObject({ poLineIndex: 0, costCodeId: null })
    expect(calls[0].data.lines[1]).toMatchObject({ poLineIndex: null, costCodeId: 'cc9' })
  })

  it('a client variation sends the client block and nulls the supplier block and the PO; the RFI travels as its id only', async () => {
    const { call, calls } = fakeCall({ variationId: 'x', variationNumber: 'CV-0001', alreadyApplied: false })
    await runCreateVariation({
      call, projectId: 'p1', variationId: 'x', uid: 'u',
      data: editorData({
        variationType: VARIATION_TYPE.CLIENT, clientId: 'contactC1', clientName: ' Client Pty ', clientRef: ' CR-1 ',
        supplierId: 'x', supplierName: 'x', supplierRef: 'x', poId: 'po1',
        originRfi: { id: 'rfi1', rfiNumber: 'RFI-0001', title: 'Steel', status: 'open' },
      }),
    })
    expect(calls[0].data).toMatchObject({
      variationType: 'client', clientId: 'contactC1', clientName: 'Client Pty', clientRef: 'CR-1',
      supplierId: null, supplierName: null, supplierRef: null, poId: null, originRfiId: 'rfi1',
    })
    expect(JSON.stringify(calls[0].data)).not.toMatch(/RFI-0001|originRfiTitle|originRfiNumber/)
  })

  it('refuses BEFORE any call: no uid, no title, no lines, a line without a cost code, an ineligible RFI, an amount beyond the supported range', async () => {
    const { call, calls } = fakeCall({ variationId: 'x', variationNumber: 'SV-1', alreadyApplied: false })
    const run = (data, over = {}) => runCreateVariation({ call, projectId: 'p1', variationId: 'x', data, uid: 'u', ...over })
    await expectKind(run(editorData(), { uid: null }), VARIATION_WRITE_ERROR.PERMISSION)
    expect((await expectKind(run(editorData({ title: '  ' })), VARIATION_WRITE_ERROR.INVALID)).message).toBe('Title is required')
    await expectKind(run(editorData({ lineItems: [] })), VARIATION_WRITE_ERROR.INVALID)
    await expectKind(run(editorData({ lineItems: [line({ costCodeId: '' })] })), VARIATION_WRITE_ERROR.INVALID)
    await expectKind(run(editorData({ originRfi: { id: 'r', rfiNumber: 'RFI-1', title: 't', status: 'draft' } })), VARIATION_WRITE_ERROR.INVALID)
    await expectKind(run(editorData({ lineItems: [line({ submittedAmount: 1e15 })] })), VARIATION_WRITE_ERROR.INVALID)
    await expectKind(run(editorData({ identifiedDate: '01/10/2026' })), VARIATION_WRITE_ERROR.INVALID)
    expect(calls).toEqual([])
  })

  it('a repeat with the SAME id is answered already-created and returned as a result; an id conflict is INVALID with the server’s message', async () => {
    const again = fakeCall({ variationId: 'x', variationNumber: 'SV-0007', alreadyApplied: true })
    await expect(runCreateVariation({ call: again.call, projectId: 'p1', variationId: 'x', data: editorData(), uid: 'u' })).resolves.toMatchObject({ alreadyApplied: true, variationNumber: 'SV-0007' })
    expect(again.calls[0].data.variationId).toBe('x')
    const conflict = fakeCall(typed('variation-id-conflict', 'A different variation already uses this identifier.'))
    const err = await expectKind(runCreateVariation({ call: conflict.call, projectId: 'p1', variationId: 'x', data: editorData(), uid: 'u' }), VARIATION_WRITE_ERROR.INVALID)
    expect(err.message).toMatch(/different variation/)
    for (const code of ['variation-rfi-invalid', 'variation-cost-code-invalid', 'variation-invalid']) {
      await expectKind(runCreateVariation({ call: fakeCall(typed(code)).call, projectId: 'p1', variationId: 'x', data: editorData(), uid: 'u' }), VARIATION_WRITE_ERROR.INVALID)
    }
    await expectKind(runCreateVariation({ call: fakeCall(typed('variation-po-invalid')).call, projectId: 'p1', variationId: 'x', data: editorData(), uid: 'u' }), VARIATION_WRITE_ERROR.PO_INVALID)
    await expectKind(runCreateVariation({ call: fakeCall(transport('deadline-exceeded')).call, projectId: 'p1', variationId: 'x', data: editorData(), uid: 'u' }), VARIATION_WRITE_ERROR.UNCERTAIN)
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
    expect(commitmentStamps('u', NOW)).toEqual({ commitmentAppliedAt: NOW, commitmentAppliedBy: 'u' })
    expect(scopeStamps('u', NOW)).toEqual({ scopeCommittedAt: NOW, scopeCommittedBy: 'u' })
    expect(Object.keys(commitmentStamps('u', NOW))).toEqual(VARIATION_COMMITMENT_KEYS)
    expect(Object.keys(scopeStamps('u', NOW))).toEqual(SCOPE_COMMITMENT_KEYS)
  })

  it('refuses BEFORE any call: no uid, no id, not approved, manual mode, client, already applied (both pairs, or applied with no positive new scope)', async () => {
    const seen = approvedLinked()
    const { call, calls } = fakeCall({ variationId: 'v1', alreadyApplied: false, byCaller: true, applied: true, scopeCommitted: true })
    const run = (over) => runApplyVariationCommitment({ call, projectId: 'p1', seen, uid: 'u_pm', ...over })
    await expectKind(run({ uid: null }), VARIATION_WRITE_ERROR.PERMISSION)
    await expectKind(run({ seen: {} }), VARIATION_WRITE_ERROR.MISSING)
    await expectKind(run({ seen: approvedLinked({ status: 'submitted' }) }), VARIATION_WRITE_ERROR.INVALID)
    await expectKind(run({ seen: approvedLinked({ status: 'rejected' }) }), VARIATION_WRITE_ERROR.INVALID)
    await expectKind(run({ seen: approvedLinked({ poId: null, poNumber: null }) }), VARIATION_WRITE_ERROR.INVALID)
    await expectKind(run({ seen: approvedLinked({ variationType: VARIATION_TYPE.CLIENT }) }), VARIATION_WRITE_ERROR.INVALID)
    await expectKind(run({ seen: approvedLinked({ ...BOTH_PAIRS }) }), VARIATION_WRITE_ERROR.ALREADY_APPLIED)
    // Applied under M3-B1 with existing-line amounts only: there is no new scope to commit.
    await expectKind(run({ seen: approvedLinked({ commitmentAppliedAt: NOW, commitmentAppliedBy: 'u_x' }) }), VARIATION_WRITE_ERROR.ALREADY_APPLIED)
    expect(calls).toHaveLength(0)
  })

  it('sends the project, the variation and the REVIEWED revision — nothing else — and returns what the server recorded', async () => {
    const seen = approvedLinked()
    const { call, calls } = fakeCall({ variationId: 'v1', alreadyApplied: false, byCaller: true, applied: true, scopeCommitted: true })
    const out = await runApplyVariationCommitment({ call, projectId: 'p1', seen, uid: 'u_pm' })
    expect(calls).toEqual([{ name: VARIATION_CALLABLE.APPLY, data: { projectId: 'p1', variationId: 'v1', expectedRevision: 2 } }])
    expect(out).toMatchObject({ applied: true, scopeCommitted: true, alreadyApplied: false })
    // A legacy document with no revision key sends 0.
    const legacy = fakeCall({ variationId: 'v1', alreadyApplied: false, byCaller: true, applied: true, scopeCommitted: true })
    await runApplyVariationCommitment({ call: legacy.call, projectId: 'p1', seen: approvedLinked({ revision: undefined }), uid: 'u' })
    expect(legacy.calls[0].data.expectedRevision).toBe(0)
  })

  it('ADR-63 — a variation applied under M3-B1 with a positive new-scope line is still sent (the server writes the SCOPE pair only)', async () => {
    const seen = approvedLinked({
      commitmentAppliedAt: NOW, commitmentAppliedBy: 'u_x',
      lineItems: [line({ poLineIndex: 0, approvedAmount: 1000, approvedGst: 100 }), line({ costCodeId: 'cc2', approvedAmount: 250, approvedGst: 25 })],
    })
    const { call, calls } = fakeCall({ variationId: 'v1', alreadyApplied: false, byCaller: true, applied: false, scopeCommitted: true })
    const out = await runApplyVariationCommitment({ call, projectId: 'p1', seen, uid: 'u_pm' })
    expect(calls).toHaveLength(1)
    expect(out).toMatchObject({ applied: false, scopeCommitted: true })
  })

  it('"already applied" by THIS user (a repeat after an unconfirmed outcome) is a result; by anyone else it is the ALREADY_APPLIED refusal — nothing was changed', async () => {
    const seen = approvedLinked()
    const mine = fakeCall({ variationId: 'v1', alreadyApplied: true, byCaller: true, applied: false, scopeCommitted: false })
    await expect(runApplyVariationCommitment({ call: mine.call, projectId: 'p1', seen, uid: 'u_pm' })).resolves.toMatchObject({ alreadyApplied: true })
    const theirs = fakeCall({ variationId: 'v1', alreadyApplied: true, byCaller: false, applied: false, scopeCommitted: false })
    const err = await expectKind(runApplyVariationCommitment({ call: theirs.call, projectId: 'p1', seen, uid: 'u_pm' }), VARIATION_WRITE_ERROR.ALREADY_APPLIED)
    expect(err.message).toBe(VARIATION_WRITE_ERROR_MESSAGES.already_applied)
  })

  it('a STALE copy, a missing document and a purchase order that is not sent or closed are the server’s refusals, mapped to their kinds with the reason', async () => {
    const seen = approvedLinked()
    const run = (err) => runApplyVariationCommitment({ call: fakeCall(err).call, projectId: 'p1', seen, uid: 'u_pm' })
    await expectKind(run(typed('variation-stale')), VARIATION_WRITE_ERROR.STALE)
    await expectKind(run(typed('not-found')), VARIATION_WRITE_ERROR.MISSING)
    const po = await expectKind(run(typed('variation-not-applicable', 'The linked purchase order is not sent or closed, so the variation cannot be applied to its commitment. Nothing was changed.')), VARIATION_WRITE_ERROR.INVALID)
    expect(po.message).toMatch(/not sent or closed/)
  })

  it('maps transport failures exactly as the other server operations do', async () => {
    const seen = approvedLinked()
    const run = (err) => runApplyVariationCommitment({ call: fakeCall(err).call, projectId: 'p1', seen, uid: 'u_pm' })
    await expectKind(run(transport('permission-denied')), VARIATION_WRITE_ERROR.PERMISSION)
    await expectKind(run(transport('unavailable')), VARIATION_WRITE_ERROR.UNCERTAIN)
    await expectKind(run(transport('deadline-exceeded')), VARIATION_WRITE_ERROR.UNCERTAIN)
    await expectKind(run(typed('variation-processing-disabled')), VARIATION_WRITE_ERROR.UNAVAILABLE)
  })
})
