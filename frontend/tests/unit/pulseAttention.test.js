import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  evaluatePulse, summarisePulse, PULSE_STATE, INDICATOR, INDICATOR_ORDER, INDICATOR_DEPENDENCIES, PULSE_SOURCES,
} from '../../src/lib/pulse'
import {
  ATTENTION, ATTENTION_REASON, ACK_STATUS, ACK_ERROR, ACK_ERROR_MESSAGES,
  EVIDENCE_KEY_LIMIT, ACK_NOTE_MAX_LENGTH, PULSE_ACK_WRITE_ROLES,
  evidenceKeysFor, normaliseEvidenceKeys, attentionFor, splitFindings,
  acknowledgementAvailability, validateAcknowledgementInput, normaliseAcknowledgementInput,
  acknowledgementErrorKind, sameAcknowledgementVersion, timestampToIso, localDayIso, isReviewDue,
  canManageAcknowledgements, ackWording,
} from '../../src/lib/pulseAttention'
import {
  runAcknowledge, runWithdraw, AcknowledgementError,
} from '../../src/lib/pulseAcknowledgementActions'
import { FINANCIAL_ROLES } from '../../src/lib/margin'
import { PROGRAMME_WRITE_ROLES } from '../../src/lib/projectTimeline'

// ── Constrapp PULSE™ 1B — acknowledgement & attention (ADR-49) ───────────────
//
// lib/pulseAttention.js derives a MANAGEMENT status beside the PULSE 1A
// evaluation; lib/pulseAcknowledgementActions.js is the guarded write. These
// tests pin:
//
//   1. finding identity — stable record ids, never position / amount / order;
//      sorted, de-duplicated, empty for a keyless or non-finding indicator;
//   2. the attention matrix — no acknowledgement, covered, new evidence,
//      review due, withdrawn, condition resolved, unknown / loading reads;
//   3. the evidence limit — >200 keys refuses, never truncates;
//   4. isolation — an acknowledgement (or a failed acknowledgement read) never
//      changes an indicator's state, a count or a figure;
//   5. the transaction runner — stale / missing / permission / offline
//      outcomes, no write on refusal, success only after commit;
//   6. structure — the module is pure (no Firebase, no React), uses no
//      forbidden vocabulary, and lib/pulse.js is untouched by it.

const read = (rel) =>
  readFileSync(fileURLToPath(new URL(`../../src/${rel}`, import.meta.url)), 'utf8')
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '')

// ── Fixture — a compact project where all six indicators are FINDINGS ────────
const NOW = new Date(2026, 9, 19) // 19 October 2026, local
const TODAY = '2026-10-19'

const posted = (id, n, costCodeId, amount, dueDate, poLineIndex = 0) => ({
  id, invoiceNumber: `SI-000${n}`, supplierInvoiceNumber: `INV-${n}00`, status: 'posted',
  supplierId: 'sup1', supplierName: 'Ace', currency: 'AUD', poId: 'po1',
  lineItems: [{ poLineIndex, costCodeId, costCodeName: costCodeId, description: 'x', amount, taxCode: 'gst', gstAmount: amount / 10 }],
  retention: 0, retentionGst: 0, retentionTotal: 0,
  subtotal: amount, gstTotal: amount / 10, grossTotal: amount * 1.1, net: amount, payableGst: amount / 10, payableTotal: amount * 1.1,
  dueDate,
})

const SOURCES = {
  budgetLines: [
    { id: 'bl1', costCodeId: 'cc1', budgeted: 1000 },
    { id: 'bl2', costCodeId: 'cc2', budgeted: 500 },
  ],
  purchaseOrders: [{ id: 'po1', status: 'sent', lineItems: [{ costCodeId: 'cc1', lineTotal: 900 }, { costCodeId: 'cc2', lineTotal: 400 }] }],
  progressClaims: [],
  supplierInvoices: [posted('inv1', 1, 'cc1', 600, '2026-01-31'), posted('inv2', 2, 'cc2', 400, '2026-02-28', 1)],
  supplierCreditNotes: [],
  variations: [
    { id: 'v2', variationNumber: 'CV-0002', title: 'Lift', variationType: 'client', status: 'submitted', submittedSubtotal: 300, clientName: 'Owner', lineItems: [] },
    { id: 'v4', variationNumber: 'SV-0002', title: 'Pump', variationType: 'supplier', status: 'draft', submittedSubtotal: 70, supplierName: 'Ace', lineItems: [{ costCodeId: 'cc2', submittedAmount: 70 }] },
  ],
  forecastLines: [
    { id: 'cc1', costCodeId: 'cc1', uncommittedCostToComplete: 900 }, // FFC cc1 = 600 actual + 300 remaining + 900 = 1800 > 1000
    { id: 'cc2', costCodeId: 'cc2', uncommittedCostToComplete: null }, // not forecast
  ],
  // cc2: 400 actual + 0 remaining, unforecast → FFC 400 (within its 500). Total FFC 2200 > contract 1500 → negative profit
  baseline: { originalContractValue: 1500, originalApprovedBudget: 1500 },
  supplierPayments: [],
  retentionReleases: [],
  activities: [
    { id: 'a1', name: 'Excavate', status: 'in_progress', isMilestone: false, plannedStart: '2026-09-01', plannedFinish: '2026-10-01' },
    { id: 'a2', name: 'Slab',     status: 'not_started', isMilestone: false, plannedStart: '2026-10-01', plannedFinish: '2026-10-10' },
    { id: 'a3', name: 'Frame',    status: 'not_started', isMilestone: false, plannedStart: '2026-10-19', plannedFinish: '2026-10-19' }, // due today: not overdue
  ],
}

const allSettled = () => Object.fromEntries(PULSE_SOURCES.map(s => [s, { loading: false, error: false }]))
const run = (sources = SOURCES, sourceStates = allSettled(), now = NOW) =>
  evaluatePulse({ sources, sourceStates, now, currencyCode: 'AUD' })
const byId = (result) => Object.fromEntries(result.indicators.map(i => [i.id, i]))
const IND = byId(run())

const ack = (overrides = {}) => ({
  id: INDICATOR.OVERDUE_ACTIVITIES, indicatorId: INDICATOR.OVERDUE_ACTIVITIES,
  status: ACK_STATUS.ACTIVE, evidenceKeys: ['a1', 'a2'], note: 'Chasing the subcontractor', reviewBy: '2026-11-02',
  acknowledgedAt: { seconds: 1_760_000_000, nanoseconds: 0 }, acknowledgedBy: 'u_pm',
  withdrawnAt: null, withdrawnBy: null, revision: 1,
  createdAt: null, createdBy: 'u_pm', updatedAt: null, updatedBy: 'u_pm',
  ...overrides,
})
const settledAck = { loading: false, error: false }
const attn = (indicator, a = null, ackState = settledAck, now = NOW) =>
  attentionFor({ indicator, ack: a, ackState, now })

// ── 0 · The fixture lands every indicator on FINDING ─────────────────────────

describe('fixture', () => {
  it('every indicator is a finding', () => {
    for (const id of INDICATOR_ORDER) expect(IND[id].state, id).toBe(PULSE_STATE.FINDING)
  })
})

// ── 1 · Finding identity ─────────────────────────────────────────────────────

describe('evidence keys — stable record ids, sorted and de-duplicated', () => {
  it('forecast indicators key on costCodeId; record indicators key on document id; gross profit has no keys', () => {
    expect(evidenceKeysFor(IND[INDICATOR.FORECAST_OVER_BUDGET])).toEqual(['cc1'])
    expect(evidenceKeysFor(IND[INDICATOR.FORECAST_INCOMPLETE])).toEqual(['cc2'])
    expect(evidenceKeysFor(IND[INDICATOR.NEGATIVE_GROSS_PROFIT])).toEqual([])
    expect(evidenceKeysFor(IND[INDICATOR.OVERDUE_ACTIVITIES])).toEqual(['a1', 'a2'])
    expect(evidenceKeysFor(IND[INDICATOR.PAST_DUE_SUPPLIER_INVOICES])).toEqual(['inv1', 'inv2'])
    expect(evidenceKeysFor(IND[INDICATOR.PENDING_VARIATION_EXPOSURE])).toEqual(['v2', 'v4'])
  })

  it('over budget includes the unbudgeted cost codes listed beside the over-budget rows', () => {
    const sources = { ...SOURCES, purchaseOrders: [...SOURCES.purchaseOrders, { id: 'po9', status: 'sent', lineItems: [{ costCodeId: 'cc9', lineTotal: 50 }] }] }
    const ind = byId(run(sources))[INDICATOR.FORECAST_OVER_BUDGET]
    expect(ind.values.unbudgetedRows.map(r => r.costCodeId)).toEqual(['cc9'])
    expect(evidenceKeysFor(ind)).toEqual(['cc1', 'cc9'])
  })

  it('a negative total variance carried by unbudgeted cost alone still yields keys', () => {
    const sources = {
      ...SOURCES,
      forecastLines: [{ id: 'cc1', costCodeId: 'cc1', uncommittedCostToComplete: 0 }, { id: 'cc2', costCodeId: 'cc2', uncommittedCostToComplete: 0 }],
      purchaseOrders: [...SOURCES.purchaseOrders, { id: 'po9', status: 'sent', lineItems: [{ costCodeId: 'cc9', lineTotal: 5000 }] }],
    }
    const ind = byId(run(sources))[INDICATOR.FORECAST_OVER_BUDGET]
    expect(ind.state).toBe(PULSE_STATE.FINDING)
    expect(ind.evidence).toEqual([]) // no budgeted row is itself over budget
    expect(evidenceKeysFor(ind)).toEqual(['cc9'])
  })

  it('identity ignores list position, amounts and render order', () => {
    const reordered = { ...SOURCES, activities: [...SOURCES.activities].reverse(), supplierInvoices: [...SOURCES.supplierInvoices].reverse() }
    const repriced = { ...SOURCES, supplierInvoices: [posted('inv1', 1, 'cc1', 6000, '2026-01-31'), posted('inv2', 2, 'cc2', 1, '2026-02-28', 1)] }
    for (const id of [INDICATOR.OVERDUE_ACTIVITIES, INDICATOR.PAST_DUE_SUPPLIER_INVOICES, INDICATOR.PENDING_VARIATION_EXPOSURE]) {
      expect(evidenceKeysFor(byId(run(reordered))[id])).toEqual(evidenceKeysFor(IND[id]))
    }
    expect(evidenceKeysFor(byId(run(repriced))[INDICATOR.PAST_DUE_SUPPLIER_INVOICES])).toEqual(['inv1', 'inv2'])
  })

  it('normaliseEvidenceKeys sorts, de-duplicates and drops non-string / empty keys', () => {
    expect(normaliseEvidenceKeys(['b', 'a', 'b', '', null, 3, 'a'])).toEqual(['a', 'b'])
    expect(normaliseEvidenceKeys(undefined)).toEqual([])
  })

  it('a malformed stored acknowledgement never throws: non-list keys, non-string note/date, missing revision', () => {
    for (const keys of ['a1', 42, { a1: true }, null]) {
      expect(normaliseEvidenceKeys(keys)).toEqual([])
      const a = attn(IND[INDICATOR.OVERDUE_ACTIVITIES], ack({ evidenceKeys: keys, note: 7, reviewBy: 20261102, revision: undefined }))
      expect(a.state).toBe(ATTENTION.NEEDS_ATTENTION) // every current key is "new"
    }
    expect(sameAcknowledgementVersion({ revision: undefined }, { revision: undefined })).toBe(false)
  })

  it('a non-finding indicator has no evidence keys', () => {
    const loading = byId(run(SOURCES, { ...allSettled(), activities: { loading: true, error: false } }))
    expect(loading[INDICATOR.OVERDUE_ACTIVITIES].state).toBe(PULSE_STATE.LOADING)
    expect(evidenceKeysFor(loading[INDICATOR.OVERDUE_ACTIVITIES])).toEqual([])
    const noIssue = byId(run({ ...SOURCES, variations: [] }))[INDICATOR.PENDING_VARIATION_EXPOSURE]
    expect(noIssue.state).toBe(PULSE_STATE.NO_ISSUE)
    expect(evidenceKeysFor(noIssue)).toEqual([])
    expect(evidenceKeysFor(null)).toEqual([])
  })

  it('does not mutate the indicator', () => {
    const before = JSON.stringify(IND[INDICATOR.OVERDUE_ACTIVITIES])
    evidenceKeysFor(IND[INDICATOR.OVERDUE_ACTIVITIES])
    attn(IND[INDICATOR.OVERDUE_ACTIVITIES], ack())
    expect(JSON.stringify(IND[INDICATOR.OVERDUE_ACTIVITIES])).toBe(before)
  })
})

// ── 2 · The attention matrix ─────────────────────────────────────────────────

describe('attention — a finding with no standing acknowledgement needs attention', () => {
  it('no acknowledgement', () => {
    const a = attn(IND[INDICATOR.OVERDUE_ACTIVITIES])
    expect(a.state).toBe(ATTENTION.NEEDS_ATTENTION)
    expect(a.reason).toBe(ATTENTION_REASON.NONE)
    expect(a.currentKeys).toEqual(['a1', 'a2'])
    expect(a.ack).toBeNull()
  })

  it('covered: same keys, review date in the future → acknowledged', () => {
    const a = attn(IND[INDICATOR.OVERDUE_ACTIVITIES], ack())
    expect(a.state).toBe(ATTENTION.ACKNOWLEDGED)
    expect(a.newKeys).toEqual([])
    expect(a.clearedKeys).toEqual([])
    expect(a.reviewDue).toBe(false)
  })

  it('new evidence since the acknowledgement → needs attention, naming the new keys', () => {
    const a = attn(IND[INDICATOR.OVERDUE_ACTIVITIES], ack({ evidenceKeys: ['a1'] }))
    expect(a.state).toBe(ATTENTION.NEEDS_ATTENTION)
    expect(a.reason).toBe(ATTENTION_REASON.NEW_EVIDENCE)
    expect(a.newKeys).toEqual(['a2'])
  })

  it('new evidence wins over a review date that is also due', () => {
    const a = attn(IND[INDICATOR.OVERDUE_ACTIVITIES], ack({ evidenceKeys: ['a1'], reviewBy: '2026-01-01' }))
    expect(a.reason).toBe(ATTENTION_REASON.NEW_EVIDENCE)
    expect(a.reviewDue).toBe(true)
  })

  it('acknowledged records that are no longer present are reported but do not reopen attention', () => {
    const a = attn(IND[INDICATOR.OVERDUE_ACTIVITIES], ack({ evidenceKeys: ['a1', 'a2', 'a9'] }))
    expect(a.state).toBe(ATTENTION.ACKNOWLEDGED)
    expect(a.clearedKeys).toEqual(['a9'])
  })

  it('a superset acknowledged in a different order is still a cover', () => {
    const a = attn(IND[INDICATOR.OVERDUE_ACTIVITIES], ack({ evidenceKeys: ['a2', 'a1', 'a1'] }))
    expect(a.state).toBe(ATTENTION.ACKNOWLEDGED)
  })

  it('review date arrived today → needs attention; yesterday → needs attention; tomorrow → acknowledged', () => {
    expect(attn(IND[INDICATOR.OVERDUE_ACTIVITIES], ack({ reviewBy: TODAY })).reason).toBe(ATTENTION_REASON.REVIEW_DUE)
    expect(attn(IND[INDICATOR.OVERDUE_ACTIVITIES], ack({ reviewBy: '2026-10-18' })).reason).toBe(ATTENTION_REASON.REVIEW_DUE)
    expect(attn(IND[INDICATOR.OVERDUE_ACTIVITIES], ack({ reviewBy: '2026-10-20' })).state).toBe(ATTENTION.ACKNOWLEDGED)
  })

  it('the clock moving past the review date reopens attention with no data change', () => {
    const a = ack({ reviewBy: '2026-11-02' })
    expect(attn(IND[INDICATOR.OVERDUE_ACTIVITIES], a, settledAck, new Date(2026, 10, 1)).state).toBe(ATTENTION.ACKNOWLEDGED)
    expect(attn(IND[INDICATOR.OVERDUE_ACTIVITIES], a, settledAck, new Date(2026, 10, 2)).reason).toBe(ATTENTION_REASON.REVIEW_DUE)
  })

  it('an unparseable stored review date counts as due, never as open-ended', () => {
    expect(isReviewDue('not-a-date', TODAY)).toBe(true)
    expect(isReviewDue('2026-02-30', TODAY)).toBe(true)
    expect(attn(IND[INDICATOR.OVERDUE_ACTIVITIES], ack({ reviewBy: 'soon' })).reason).toBe(ATTENTION_REASON.REVIEW_DUE)
  })

  it('withdrawn → needs attention, carrying the withdrawn document', () => {
    const a = attn(IND[INDICATOR.OVERDUE_ACTIVITIES], ack({ status: ACK_STATUS.WITHDRAWN, withdrawnBy: 'u_admin' }))
    expect(a.state).toBe(ATTENTION.NEEDS_ATTENTION)
    expect(a.reason).toBe(ATTENTION_REASON.WITHDRAWN)
    expect(a.ack.withdrawnBy).toBe('u_admin')
  })

  it('an unknown status is treated as not active', () => {
    expect(attn(IND[INDICATOR.OVERDUE_ACTIVITIES], ack({ status: 'resolved' })).reason).toBe(ATTENTION_REASON.WITHDRAWN)
  })

  it('a keyless (project-level) finding is covered until its review date — the only lapse it has', () => {
    const gp = IND[INDICATOR.NEGATIVE_GROSS_PROFIT]
    const a = ack({ id: gp.id, indicatorId: gp.id, evidenceKeys: [] })
    expect(attn(gp, a).state).toBe(ATTENTION.ACKNOWLEDGED)
    expect(attn(gp, { ...a, reviewBy: TODAY }).reason).toBe(ATTENTION_REASON.REVIEW_DUE)
    // Keys recorded against a keyless finding are "cleared", never "new".
    expect(attn(gp, { ...a, evidenceKeys: ['x'] }).state).toBe(ATTENTION.ACKNOWLEDGED)
  })

  it('an acknowledgement with an empty key set against a keyed finding: every current key is new', () => {
    const a = attn(IND[INDICATOR.PAST_DUE_SUPPLIER_INVOICES], ack({ evidenceKeys: [] }))
    expect(a.reason).toBe(ATTENTION_REASON.NEW_EVIDENCE)
    expect(a.newKeys).toEqual(['inv1', 'inv2'])
  })
})

describe('attention — resolution is derived only from the condition disappearing', () => {
  const resolved = byId(run({ ...SOURCES, variations: [] }))[INDICATOR.PENDING_VARIATION_EXPOSURE]

  it('no issue + active acknowledgement → no longer present (acknowledgement shown, not deleted, no resolvedAt)', () => {
    const a = attn(resolved, ack({ id: resolved.id, indicatorId: resolved.id, evidenceKeys: ['v2', 'v4'] }))
    expect(resolved.state).toBe(PULSE_STATE.NO_ISSUE)
    expect(a.state).toBe(ATTENTION.NO_LONGER_PRESENT)
    expect(a.ack).not.toBeNull()
    expect(Object.keys(a)).not.toContain('resolvedAt')
  })

  it('no issue + withdrawn or no acknowledgement → not applicable', () => {
    expect(attn(resolved).state).toBe(ATTENTION.NOT_APPLICABLE)
    expect(attn(resolved, ack({ status: ACK_STATUS.WITHDRAWN })).state).toBe(ATTENTION.NOT_APPLICABLE)
  })

  it('reappearance with the SAME keys before the review date reads as still acknowledged — the documented limitation', () => {
    const a = ack({ id: resolved.id, indicatorId: resolved.id, evidenceKeys: ['v2', 'v4'] })
    expect(attn(resolved, a).state).toBe(ATTENTION.NO_LONGER_PRESENT)
    // …the variations come back unchanged:
    expect(attn(IND[INDICATOR.PENDING_VARIATION_EXPOSURE], a).state).toBe(ATTENTION.ACKNOWLEDGED)
    // …but the review date still bounds it:
    expect(attn(IND[INDICATOR.PENDING_VARIATION_EXPOSURE], { ...a, reviewBy: TODAY }).reason).toBe(ATTENTION_REASON.REVIEW_DUE)
    // …and a DIFFERENT record reopens it at once:
    const changed = byId(run({ ...SOURCES, variations: [{ ...SOURCES.variations[0], id: 'v7' }] }))[INDICATOR.PENDING_VARIATION_EXPOSURE]
    expect(attn(changed, a).reason).toBe(ATTENTION_REASON.NEW_EVIDENCE)
  })

  it('loading, unavailable and needs-data indicators are not applicable — with or without an acknowledgement', () => {
    const states = byId(run(
      { ...SOURCES, budgetLines: [] },
      { ...allSettled(), activities: { loading: true, error: false }, supplierPayments: { loading: false, error: true } },
    ))
    expect(states[INDICATOR.OVERDUE_ACTIVITIES].state).toBe(PULSE_STATE.LOADING)
    expect(states[INDICATOR.PAST_DUE_SUPPLIER_INVOICES].state).toBe(PULSE_STATE.UNAVAILABLE)
    expect(states[INDICATOR.FORECAST_OVER_BUDGET].state).toBe(PULSE_STATE.NEEDS_DATA)
    for (const id of [INDICATOR.OVERDUE_ACTIVITIES, INDICATOR.PAST_DUE_SUPPLIER_INVOICES, INDICATOR.FORECAST_OVER_BUDGET]) {
      expect(attn(states[id]).state).toBe(ATTENTION.NOT_APPLICABLE)
      expect(attn(states[id], ack({ id, indicatorId: id })).state).toBe(ATTENTION.NOT_APPLICABLE)
    }
  })
})

describe('attention — an unknown acknowledgement read is never "nobody acknowledged"', () => {
  it('loading → LOADING; failed → UNKNOWN, regardless of what the finding or the stale list says', () => {
    for (const a of [null, ack()]) {
      expect(attn(IND[INDICATOR.OVERDUE_ACTIVITIES], a, { loading: true, error: false }).state).toBe(ATTENTION.LOADING)
      expect(attn(IND[INDICATOR.OVERDUE_ACTIVITIES], a, { loading: false, error: true }).state).toBe(ATTENTION.UNKNOWN)
    }
    expect(attn(IND[INDICATOR.OVERDUE_ACTIVITIES], null, { loading: false, error: true }).reason).toBeNull()
  })

  it('missing indicator → not applicable', () => {
    expect(attentionFor({}).state).toBe(ATTENTION.NOT_APPLICABLE)
    expect(attentionFor().state).toBe(ATTENTION.NOT_APPLICABLE)
  })
})

describe('splitFindings — findings only, fixed order kept within each group', () => {
  it('splits by attention and keeps INDICATOR_ORDER', () => {
    const attention = {
      [INDICATOR.FORECAST_OVER_BUDGET]:       { state: ATTENTION.ACKNOWLEDGED },
      [INDICATOR.FORECAST_INCOMPLETE]:        { state: ATTENTION.NEEDS_ATTENTION },
      [INDICATOR.NEGATIVE_GROSS_PROFIT]:      { state: ATTENTION.NEEDS_ATTENTION },
      [INDICATOR.OVERDUE_ACTIVITIES]:         { state: ATTENTION.UNKNOWN },
      [INDICATOR.PAST_DUE_SUPPLIER_INVOICES]: { state: ATTENTION.ACKNOWLEDGED },
      [INDICATOR.PENDING_VARIATION_EXPOSURE]: { state: ATTENTION.LOADING },
    }
    const s = splitFindings(run().indicators, attention)
    expect(s.needsAttention.map(i => i.id)).toEqual([INDICATOR.FORECAST_INCOMPLETE, INDICATOR.NEGATIVE_GROSS_PROFIT])
    expect(s.acknowledged.map(i => i.id)).toEqual([INDICATOR.FORECAST_OVER_BUDGET, INDICATOR.PAST_DUE_SUPPLIER_INVOICES])
    expect(s.unknown.map(i => i.id)).toEqual([INDICATOR.OVERDUE_ACTIVITIES, INDICATOR.PENDING_VARIATION_EXPOSURE])
  })

  it('non-findings never appear in any group', () => {
    const s = splitFindings(run({ ...SOURCES, variations: [] }).indicators, {})
    expect([...s.needsAttention, ...s.acknowledged, ...s.unknown].map(i => i.id)).not.toContain(INDICATOR.PENDING_VARIATION_EXPOSURE)
    expect(s.unknown).toHaveLength(5) // no attention supplied → unknown bucket
  })
})

// ── 3 · The evidence limit ───────────────────────────────────────────────────

describe('evidence limit — more than 200 records refuses, never truncates', () => {
  const many = Array.from({ length: 201 }, (_, i) => ({
    id: `act${String(i).padStart(3, '0')}`, name: `A${i}`, status: 'not_started', isMilestone: false,
    plannedStart: '2026-01-01', plannedFinish: '2026-01-02',
  }))
  const over = byId(run({ ...SOURCES, activities: many }))[INDICATOR.OVERDUE_ACTIVITIES]
  const atLimit = byId(run({ ...SOURCES, activities: many.slice(0, 200) }))[INDICATOR.OVERDUE_ACTIVITIES]

  it('the limit is 200 and 201 keys are all still reported', () => {
    expect(EVIDENCE_KEY_LIMIT).toBe(200)
    expect(evidenceKeysFor(over)).toHaveLength(201)
    expect(acknowledgementAvailability(over)).toEqual({ ok: false, reason: 'too_many_evidence', keyCount: 201 })
    expect(acknowledgementAvailability(atLimit)).toEqual({ ok: true, reason: null, keyCount: 200 })
  })

  it('a non-finding is not acknowledgeable', () => {
    expect(acknowledgementAvailability(byId(run({ ...SOURCES, variations: [] }))[INDICATOR.PENDING_VARIATION_EXPOSURE]).reason).toBe('not_a_finding')
    expect(acknowledgementAvailability(null).ok).toBe(false)
  })

  it('the runner refuses 201 keys before any transaction (nothing partial is saved)', async () => {
    let ran = false
    await expect(runAcknowledge({
      db: {}, ref: {}, indicatorId: INDICATOR.OVERDUE_ACTIVITIES, seen: null,
      evidenceKeys: evidenceKeysFor(over), note: 'n', reviewBy: '2026-12-01', uid: 'u',
      runTransaction: async () => { ran = true }, serverTimestamp: () => 'ts',
    })).rejects.toMatchObject({ kind: ACK_ERROR.INVALID })
    expect(ran).toBe(false)
  })
})

// ── 4 · Isolation — PULSE 1A is untouched ────────────────────────────────────

describe('isolation — acknowledgements change no indicator state, count or figure', () => {
  it('evaluatePulse ignores an acknowledgement source and a FAILED acknowledgement source state', () => {
    const base = run()
    const withAck = evaluatePulse({
      sources: { ...SOURCES, pulseAcknowledgements: [ack()] },
      sourceStates: { ...allSettled(), pulseAcknowledgements: { loading: false, error: true } },
      now: NOW, currencyCode: 'AUD',
    })
    expect(JSON.stringify(withAck)).toBe(JSON.stringify(base))
    expect(summarisePulse(withAck.indicators)).toEqual(summarisePulse(base.indicators))
  })

  it('the acknowledgement subscription is in no dependency list and is not a PULSE source', () => {
    expect(PULSE_SOURCES).not.toContain('pulseAcknowledgements')
    for (const deps of Object.values(INDICATOR_DEPENDENCIES)) expect(deps).not.toContain('pulseAcknowledgements')
  })

  it('attention carries no monetary value and the indicator figures are the same object the page renders', () => {
    const ind = IND[INDICATOR.FORECAST_OVER_BUDGET]
    const a = attn(ind, ack({ id: ind.id, indicatorId: ind.id, evidenceKeys: evidenceKeysFor(ind) }))
    expect(a.state).toBe(ATTENTION.ACKNOWLEDGED)
    for (const k of Object.keys(a)) expect(['approvedBudget', 'forecastFinalCost', 'varianceToBudget']).not.toContain(k)
    expect(ind.values.varianceToBudget).toBe(-700) // 1500 budget − 2200 FFC, from projectForecastTotals
  })

  it('lib/pulse.js does not import or mention the acknowledgement layer', () => {
    const src = stripComments(read('lib/pulse.js'))
    expect(src).not.toMatch(/pulseAttention|pulseAcknowledgement|acknowledg/i)
  })
})

// ── 5 · Input validation & roles ─────────────────────────────────────────────

describe('input validation — the client mirror of the rules block', () => {
  it('note required, non-blank, ≤ 500; review date valid ISO and after today', () => {
    expect(validateAcknowledgementInput({ note: '', reviewBy: '2026-10-20' }, NOW)).toMatch(/note is required/)
    expect(validateAcknowledgementInput({ note: '   ', reviewBy: '2026-10-20' }, NOW)).toMatch(/note is required/)
    expect(validateAcknowledgementInput({ note: 'x'.repeat(ACK_NOTE_MAX_LENGTH + 1), reviewBy: '2026-10-20' }, NOW)).toMatch(/500/)
    expect(validateAcknowledgementInput({ note: 'x'.repeat(ACK_NOTE_MAX_LENGTH), reviewBy: '2026-10-20' }, NOW)).toBeNull()
    expect(validateAcknowledgementInput({ note: 'ok', reviewBy: '' }, NOW)).toMatch(/review-by date is required/)
    expect(validateAcknowledgementInput({ note: 'ok', reviewBy: '20/10/2026' }, NOW)).toMatch(/review-by date is required/)
    expect(validateAcknowledgementInput({ note: 'ok', reviewBy: '2026-02-30' }, NOW)).toMatch(/review-by date is required/)
    expect(validateAcknowledgementInput({ note: 'ok', reviewBy: TODAY }, NOW)).toMatch(/after today/)
    expect(validateAcknowledgementInput({ note: 'ok', reviewBy: '2026-10-18' }, NOW)).toMatch(/after today/)
    expect(validateAcknowledgementInput({ note: 'ok', reviewBy: '2026-10-20' }, NOW)).toBeNull()
    expect(validateAcknowledgementInput(undefined, NOW)).toMatch(/note is required/)
  })

  it('normalises by trimming the note only', () => {
    expect(normaliseAcknowledgementInput({ note: '  hello \n', reviewBy: '2026-10-20' })).toEqual({ note: 'hello', reviewBy: '2026-10-20' })
  })

  it('write roles are admin and PM — the programme-writer audience; qs, subcontractor and client cannot', () => {
    expect([...PULSE_ACK_WRITE_ROLES].sort()).toEqual([...PROGRAMME_WRITE_ROLES].sort())
    expect(canManageAcknowledgements('company_admin')).toBe(true)
    expect(canManageAcknowledgements('project_manager')).toBe(true)
    for (const r of ['qs', 'subcontractor', 'client', 'super_admin', undefined, null]) expect(canManageAcknowledgements(r), String(r)).toBe(false)
    // Every writer is also a reader of PULSE.
    for (const r of PULSE_ACK_WRITE_ROLES) expect(FINANCIAL_ROLES).toContain(r)
  })

  it('pending variation exposure is worded as a review; everything else as an acknowledgement', () => {
    expect(ackWording(INDICATOR.PENDING_VARIATION_EXPOSURE).past).toBe('Reviewed')
    for (const id of INDICATOR_ORDER.filter(i => i !== INDICATOR.PENDING_VARIATION_EXPOSURE)) expect(ackWording(id).past).toBe('Acknowledged')
  })

  it('dates: local day ISO and Firestore timestamp conversion', () => {
    expect(localDayIso(NOW)).toBe(TODAY)
    expect(timestampToIso(null)).toBeNull()
    expect(timestampToIso({ toDate: () => new Date(2026, 9, 19, 23, 59) })).toBe(TODAY)
    expect(timestampToIso({ seconds: Math.floor(new Date(2026, 9, 19, 12).getTime() / 1000), nanoseconds: 0 })).toBe(TODAY)
    expect(timestampToIso({})).toBeNull()
  })
})

// ── 6 · The guarded writes ───────────────────────────────────────────────────

// A fake transaction: `docs` is the server copy; writes are recorded.
function fakeTx(data) {
  const writes = []
  const tx = {
    get: async () => ({ exists: () => data != null, data: () => data }),
    set: (ref, payload) => writes.push(['set', payload]),
    update: (ref, payload) => writes.push(['update', payload]),
  }
  return { tx, writes }
}
const runWith = (data) => {
  const { tx, writes } = fakeTx(data)
  return { writes, runTransaction: async (db, body) => body(tx) }
}
const baseArgs = (extra = {}) => ({
  db: {}, ref: { id: INDICATOR.OVERDUE_ACTIVITIES }, indicatorId: INDICATOR.OVERDUE_ACTIVITIES,
  seen: null, evidenceKeys: ['a2', 'a1'], note: 'Chasing', reviewBy: '2026-11-02', uid: 'u_pm',
  serverTimestamp: () => 'SERVER_TIME', ...extra,
})

describe('runAcknowledge — first acknowledgement', () => {
  it('creates revision 1 as active with sorted keys, server stamps, caller ids and null withdraw stamps', async () => {
    const { writes, runTransaction } = runWith(null)
    const out = await runAcknowledge(baseArgs({ runTransaction }))
    expect(out).toEqual({ kind: null, revision: 1 })
    expect(writes).toHaveLength(1)
    const [op, payload] = writes[0]
    expect(op).toBe('set')
    expect(payload).toEqual({
      indicatorId: INDICATOR.OVERDUE_ACTIVITIES, status: 'active', evidenceKeys: ['a1', 'a2'],
      note: 'Chasing', reviewBy: '2026-11-02',
      acknowledgedAt: 'SERVER_TIME', acknowledgedBy: 'u_pm', withdrawnAt: null, withdrawnBy: null,
      updatedAt: 'SERVER_TIME', updatedBy: 'u_pm', revision: 1, createdAt: 'SERVER_TIME', createdBy: 'u_pm',
    })
  })

  it('refuses as STALE when the user saw nothing but a document now exists (another manager acknowledged first)', async () => {
    const { writes, runTransaction } = runWith(ack({ revision: 1 }))
    await expect(runAcknowledge(baseArgs({ runTransaction }))).rejects.toMatchObject({ kind: ACK_ERROR.STALE })
    expect(writes).toHaveLength(0)
  })
})

describe('runAcknowledge — re-acknowledgement', () => {
  it('writes revision + 1 and preserves createdAt / createdBy / indicatorId by not touching them', async () => {
    const current = ack({ revision: 3, status: ACK_STATUS.WITHDRAWN, withdrawnAt: 'x', withdrawnBy: 'u_admin' })
    const { writes, runTransaction } = runWith(current)
    const out = await runAcknowledge(baseArgs({ runTransaction, seen: { revision: 3 } }))
    expect(out.revision).toBe(4)
    const [op, payload] = writes[0]
    expect(op).toBe('update')
    expect(payload.revision).toBe(4)
    expect(payload.status).toBe('active')
    expect(payload.withdrawnAt).toBeNull()
    expect(payload.withdrawnBy).toBeNull()
    expect(payload.acknowledgedBy).toBe('u_pm')
    expect(Object.keys(payload)).not.toContain('createdAt')
    expect(Object.keys(payload)).not.toContain('createdBy')
    expect(Object.keys(payload)).not.toContain('indicatorId')
  })

  it('refuses as STALE on a revision mismatch — the concurrent-update case — and writes nothing', async () => {
    const { writes, runTransaction } = runWith(ack({ revision: 2 }))
    await expect(runAcknowledge(baseArgs({ runTransaction, seen: { revision: 1 } }))).rejects.toMatchObject({ kind: ACK_ERROR.STALE })
    expect(writes).toHaveLength(0)
  })

  it('refuses as STALE when the user saw a document that no longer exists', async () => {
    const { writes, runTransaction } = runWith(null)
    await expect(runAcknowledge(baseArgs({ runTransaction, seen: { revision: 1 } }))).rejects.toMatchObject({ kind: ACK_ERROR.STALE })
    expect(writes).toHaveLength(0)
  })

  it('a locally-pending (non-integer) seen revision never matches', () => {
    expect(sameAcknowledgementVersion({ revision: undefined }, { revision: 1 })).toBe(false)
    expect(sameAcknowledgementVersion({ revision: 1 }, { revision: 1 })).toBe(true)
    expect(sameAcknowledgementVersion(null, { revision: 1 })).toBe(false)
  })

  it('refuses without a uid (PERMISSION) or with a malformed indicator id (INVALID) before any transaction', async () => {
    let ran = false
    const runTransaction = async () => { ran = true }
    await expect(runAcknowledge(baseArgs({ runTransaction, uid: null }))).rejects.toMatchObject({ kind: ACK_ERROR.PERMISSION })
    await expect(runAcknowledge(baseArgs({ runTransaction, indicatorId: 'forecast/../x' }))).rejects.toMatchObject({ kind: ACK_ERROR.INVALID })
    expect(ran).toBe(false)
  })
})

describe('runAcknowledge / runWithdraw — Firestore failures are reported, never claimed as success', () => {
  const failing = (code) => async () => { const e = new Error(code); e.code = code; throw e }

  it('permission-denied → PERMISSION; unavailable → OFFLINE; aborted → STALE; not-found → MISSING; other → UNKNOWN', async () => {
    for (const [code, kind] of [
      ['permission-denied', ACK_ERROR.PERMISSION], ['unauthenticated', ACK_ERROR.PERMISSION],
      ['unavailable', ACK_ERROR.OFFLINE], ['deadline-exceeded', ACK_ERROR.OFFLINE],
      ['aborted', ACK_ERROR.STALE], ['failed-precondition', ACK_ERROR.STALE],
      ['not-found', ACK_ERROR.MISSING], ['internal', ACK_ERROR.UNKNOWN], [undefined, ACK_ERROR.UNKNOWN],
    ]) {
      expect(acknowledgementErrorKind(code), String(code)).toBe(kind)
      const err = await runAcknowledge(baseArgs({ runTransaction: failing(code) })).catch(e => e)
      expect(err).toBeInstanceOf(AcknowledgementError)
      expect(err.kind).toBe(kind)
      expect(err.message).toBe(ACK_ERROR_MESSAGES[kind])
      expect(err.message).toMatch(/Nothing was (saved|changed)/)
    }
  })

  it('a validation message passed explicitly is shown in place of the generic one', () => {
    const e = new AcknowledgementError(ACK_ERROR.INVALID, 'custom')
    expect(e.message).toBe('custom')
    expect(e.name).toBe('AcknowledgementError')
  })

  it('the promise resolves only after runTransaction resolves (no optimistic success)', async () => {
    let committed = false
    const runTransaction = (db, body) => new Promise(resolve => setTimeout(async () => {
      const { tx } = fakeTx(null)
      const r = await body(tx)
      committed = true
      resolve(r)
    }, 5))
    const p = runAcknowledge(baseArgs({ runTransaction }))
    expect(committed).toBe(false)
    await p
    expect(committed).toBe(true)
  })
})

describe('runWithdraw', () => {
  const withdrawArgs = (extra = {}) => ({
    db: {}, ref: {}, seen: { revision: 2 }, uid: 'u_admin', serverTimestamp: () => 'SERVER_TIME', ...extra,
  })

  it('withdraws an active acknowledgement: status, withdraw stamps, revision + 1, audit stamps — nothing else', async () => {
    const { writes, runTransaction } = runWith(ack({ revision: 2 }))
    const out = await runWithdraw(withdrawArgs({ runTransaction }))
    expect(out.revision).toBe(3)
    expect(writes).toEqual([['update', {
      status: 'withdrawn', withdrawnAt: 'SERVER_TIME', withdrawnBy: 'u_admin', revision: 3,
      updatedAt: 'SERVER_TIME', updatedBy: 'u_admin',
    }]])
  })

  it('refuses STALE on a revision mismatch, INVALID when already withdrawn, MISSING when absent — writing nothing', async () => {
    for (const [data, seen, kind] of [
      [ack({ revision: 3 }), { revision: 2 }, ACK_ERROR.STALE],
      [ack({ revision: 2, status: ACK_STATUS.WITHDRAWN }), { revision: 2 }, ACK_ERROR.INVALID],
      [null, { revision: 2 }, ACK_ERROR.MISSING],
    ]) {
      const { writes, runTransaction } = runWith(data)
      await expect(runWithdraw(withdrawArgs({ runTransaction, seen }))).rejects.toMatchObject({ kind })
      expect(writes).toHaveLength(0)
    }
  })

  it('refuses without a seen document or without a uid before any transaction', async () => {
    let ran = false
    const runTransaction = async () => { ran = true }
    await expect(runWithdraw(withdrawArgs({ runTransaction, seen: null }))).rejects.toMatchObject({ kind: ACK_ERROR.MISSING })
    await expect(runWithdraw(withdrawArgs({ runTransaction, uid: '' }))).rejects.toMatchObject({ kind: ACK_ERROR.PERMISSION })
    expect(ran).toBe(false)
  })
})

// ── 7 · Structure ────────────────────────────────────────────────────────────

describe('lib/pulseAttention.js and lib/pulseAcknowledgementActions.js — pure, composition only', () => {
  const attention = stripComments(read('lib/pulseAttention.js'))
  const actions = stripComments(read('lib/pulseAcknowledgementActions.js'))

  it('no Firebase, no React, no currency formatting, no money arithmetic', () => {
    for (const src of [attention, actions]) {
      expect(src).not.toMatch(/from 'firebase/)
      expect(src).not.toMatch(/from 'react/)
      expect(src).not.toMatch(/formatCurrency|roundMoney|stageProjectCurrencyLock/)
    }
  })

  it('no score, severity, threshold, trend or prediction vocabulary (the ADR-47 ban extends to 1B)', () => {
    for (const word of ['score', 'severity', 'threshold', 'trend', 'predict', 'risk level', 'weight', 'priority']) {
      expect(attention.toLowerCase(), word).not.toContain(word)
      expect(actions.toLowerCase(), word).not.toContain(word)
    }
  })

  it('the write path stages no currency lock, touches no other collection, and injects the SDK', () => {
    expect(actions).not.toMatch(/budgetLines|forecastLines|supplierInvoices|variations|activities|baseline/)
    expect(actions).toContain('runTransaction, serverTimestamp')
    const hook = stripComments(read('hooks/usePulseAcknowledgements.jsx'))
    expect(hook).not.toContain('stageProjectCurrencyLock')
    expect(hook).toMatch(/'pulseAcknowledgements'\)/)
    expect(hook.match(/collection\(db, 'companies', companyId, 'projects', projectId, 'pulseAcknowledgements'\)/g)).toHaveLength(1)
    expect(hook).not.toMatch(/addDoc|deleteDoc|writeBatch|collectionGroup/)
    // Every write callback starts with the auth guard.
    expect(hook.match(/if \(!companyId \|\| !projectId \|\| !user\) throw new Error\('Not authenticated'\)/g)).toHaveLength(2)
  })

  it('the rules block exists for the collection with the six-indicator allowlist and no delete', () => {
    const rules = readFileSync(fileURLToPath(new URL('../../firestore.rules', import.meta.url)), 'utf8')
    const start = rules.indexOf('match /companies/{companyId}/projects/{projectId}/pulseAcknowledgements/{indicatorId}')
    expect(start).toBeGreaterThan(-1)
    const block = rules.slice(start, rules.indexOf('allow delete: if false;', start))
    for (const id of Object.values(INDICATOR)) expect(block).toContain(`'${id}'`)
    expect(block).toContain("in ['company_admin', 'project_manager']")
    expect(block).toContain('evidenceKeys.size() <= 200')
    expect(block).toContain('note.size() <= 500')
    expect(block).toContain('revision == resource.data.revision + 1')
  })
})

// ── 8 · Page wiring ──────────────────────────────────────────────────────────

describe('ProjectPulse wiring — attention beside the evaluation, role-gated writes, project switch', () => {
  const page = stripComments(read('pages/project/ProjectPulse.jsx'))
  const workspace = page.slice(page.indexOf('function PulseWorkspace'))
  const card = stripComments(read('pages/project/pulse/IndicatorCard.jsx'))
  const panel = stripComments(read('pages/project/pulse/AcknowledgementPanel.jsx'))

  it('attention is derived from attentionFor over the acknowledgement subscription — after evaluatePulse, never inside it', () => {
    expect(workspace.indexOf('attentionFor(')).toBeGreaterThan(workspace.indexOf('evaluatePulse('))
    expect(workspace).toMatch(/ackState = \{ loading: pulseAcknowledgementsLoading, error: pulseAcknowledgementsError \}/)
    expect(workspace).toContain('splitFindings(pulse.indicators, attentionById)')
  })

  it('the state counts are the unchanged PULSE 1A summary', () => {
    expect(workspace).toContain('count={pulse.summary.counts[s]}')
    expect(workspace).not.toMatch(/counts\[[^\]]*\]\s*[-+]/)
  })

  it('writes are offered only to canManageAcknowledgements(role); the role comes from the gated wrapper', () => {
    expect(workspace).toContain('const canManage = canManageAcknowledgements(role)')
    expect(page).toContain('role={profile?.role}')
    expect(page).toContain("currentUid={user?.uid ?? null}")
    expect(panel).toContain('canManage &&')
    expect(panel).not.toMatch(/from '\.\.\/\.\.\/\.\.\/hooks\//)
  })

  it('the acknowledgement hook is keyed by project like every other subscription (project switch isolation)', () => {
    const hook = stripComments(read('hooks/usePulseAcknowledgements.jsx'))
    expect(hook).toContain('const key = `${companyId}/${projectId}`')
    expect(hook).toContain('const targetKey = companyId && projectId ? `${companyId}/${projectId}` : null')
    expect(hook).toContain('const pulseAcknowledgementsError = settled ? snap.error : false')
  })

  it('the card passes the panel the derived attention and never decides it; the panel shows You / Another user', () => {
    expect(card).toContain('<AcknowledgementPanel')
    expect(card).not.toContain('attentionFor(')
    expect(panel).toContain("'You' : 'Another user'")
    expect(panel).not.toMatch(/resolvedAt|resolved_at/)
    expect(panel).toContain('review by')
  })

  it('no notifications surface, no bell, no assignment UI', () => {
    for (const src of [page, card, panel]) {
      expect(src).not.toMatch(/notif|bell|assign to|Assign/i)
    }
  })
})
