import { describe, it, expect } from 'vitest'
import {
  classifyCommitmentLines, variationIncorporation, appliedSupplierVariationAdjustments,
  unappliedSupplierVariationsByCostCode, unappliedSupplierVariationsTotal, appliedSupplierVariationsTotal,
  approvedSupplierVariationsByCostCode,
  commitmentApplyEligibility, shouldApplyOnApproval, isCommitmentApplied, isPoLinkedSupplierVariation,
  COMMITMENT_LINE_KIND, COMMITMENT_LINE_ISSUE, INCORPORATION_STATE, INCORPORATION_STATE_LABELS, COMMITMENT_APPLY_BLOCKER,
  VARIATION_COMMITMENT_KEYS,
} from '../../src/lib/variations'
import {
  remainingCommittedByPoLine, remainingCommittedByCostCode, committedByCostCode, originalCommittedByCostCode,
  revisedCommitmentByPoLine, revisedLineTotal, PO_STATUS,
} from '../../src/lib/purchaseOrders'
import { recognisedClaimsByPoLine, actualClaimsByCostCode } from '../../src/lib/progressClaims'
import { postedInvoicedByPoLine, invoicedClaimIds, invoicedByCostCode } from '../../src/lib/supplierInvoices'
import { buildForecastRows, composeForecastRow, forecastRollups } from '../../src/lib/forecast'
import { projectForecastTotals, computeMargin } from '../../src/lib/margin'
import { projectSnapshot, availableFigure, FIGURE_DEPENDENCIES, FIGURE_STATE, SNAPSHOT_SOURCES } from '../../src/lib/projectSnapshot'
import { costCoverage } from '../../src/lib/cashFlow'
import { evaluatePulse, INDICATOR, PULSE_SOURCES } from '../../src/lib/pulse'
import { commitmentEffectPreview, PO_LINK_STATE } from '../../src/lib/variationCommitment'

// ── M3-B1 (ADR-62): approved supplier variation → PO commitment ──────────────
//
// The brief's regression cases, run through the REAL selectors (never a copy
// of the arithmetic). The fixture is the inspection's worked example: one sent
// PO of 100,000 on cost code X, one line.
//
//   A  PO 100,000 + SV +12,000 applied            → revised 112,000, remaining 112,000
//   B  … then 5,000 of variation work claimed      → remaining 107,000, Actual 5,000
//   C  … fully claimed 112,000, invoiced, posted   → remaining 0, Actual 112,000, nothing twice
//   D  SV −8,000 applied                            → revised 92,000
//   E  40,000 claimed first, THEN SV +12,000       → remaining 72,000
//   plus: several variations on one line, several lines / cost codes, a mixed
//   existing + new-scope variation, new-scope only, legacy (unapplied),
//   invalid links, negative revised line, duplicate documents, CTC warning,
//   Forecast / Margin / Snapshot / Cash Flow / PULSE consistency.

const APPLIED = { commitmentAppliedAt: { seconds: 1_700_000_000, nanoseconds: 0 }, commitmentAppliedBy: 'u_qs' }
// The ADR-63 scope-commitment pair (M3-B2) — positive new-scope lines mature only with it.
const SCOPE   = { scopeCommittedAt: { seconds: 1_700_000_100, nanoseconds: 0 }, scopeCommittedBy: 'u_qs' }

const PO = {
  id: 'po1', poNumber: 'PO-0001', status: PO_STATUS.SENT, supplierId: 'sup1', supplierName: 'Steel Co', subtotal: 100_000,
  lineItems: [{ costCodeId: 'X', costCodeName: '05-200 — Steel', description: 'Structural steel', qty: 1, unit: '', unitPrice: 100_000, lineTotal: 100_000 }],
}
const PO2 = {
  id: 'po2', poNumber: 'PO-0002', status: PO_STATUS.SENT, supplierId: 'sup2', supplierName: 'Form Co', subtotal: 50_000,
  lineItems: [
    { costCodeId: 'Y', costCodeName: '03-200 — Formwork', description: 'Forms', lineTotal: 30_000 },
    { costCodeId: 'Z', costCodeName: '03-100 — Concrete', description: 'Slab', lineTotal: 20_000 },
  ],
}

const svLine = (amount, over = {}) => ({
  costCodeId: 'X', costCodeName: '05-200 — Steel', description: 'Extra steel',
  submittedAmount: amount, submittedGst: amount / 10, approvedAmount: amount, approvedGst: amount / 10, poLineIndex: 0, taxCode: 'gst', ...over,
})
const sv = (id, lines, over = {}) => ({
  id, variationNumber: `SV-${id}`, variationType: 'supplier', status: 'approved', poId: 'po1', poNumber: 'PO-0001',
  supplierId: 'sup1', supplierName: 'Steel Co', lineItems: lines,
  approvedSubtotal: lines.reduce((s, l) => s + (l.approvedAmount ?? 0), 0), ...over,
})
const applied = (id, lines, over = {}) => sv(id, lines, { ...APPLIED, ...over })

const claim = (id, approvedThisPeriod, over = {}) => ({
  id, claimNumber: `PC-${id}`, status: 'approved', poId: 'po1', poNumber: 'PO-0001',
  lineItems: [{ poLineIndex: 0, costCodeId: 'X', costCodeName: '05-200 — Steel', poLineTotal: 100_000, previouslyApproved: 0, claimedToDate: approvedThisPeriod, claimedThisPeriod: approvedThisPeriod, approvedThisPeriod }],
  approvedSubtotal: approvedThisPeriod, claimedSubtotal: approvedThisPeriod, ...over,
})
const claimInvoice = (id, cl, amount) => ({
  id, invoiceNumber: `SI-${id}`, status: 'posted', source: 'progress_claim', poId: 'po1', poNumber: 'PO-0001', progressClaimId: cl.id, claimNumber: cl.claimNumber,
  lineItems: [{ poLineIndex: 0, costCodeId: 'X', costCodeName: '05-200 — Steel', amount, taxCode: 'gst', gstAmount: amount / 10 }],
  subtotal: amount, gstTotal: amount / 10, grossTotal: amount * 1.1, retention: 0, retentionGst: 0, retentionTotal: 0, net: amount, payableGst: amount / 10, payableTotal: amount * 1.1,
})

// The whole cost position at once, through the real composition.
function position({ purchaseOrders = [PO], progressClaims = [], supplierInvoices = [], variations = [], forecastLines = [], budgetLines = [{ id: 'X', costCodeId: 'X', budgeted: 150_000 }] } = {}) {
  const sources = { budgetLines, purchaseOrders, progressClaims, supplierInvoices, supplierCreditNotes: [], variations, forecastLines }
  const rows = buildForecastRows(sources).map(r => composeForecastRow(r, r.storedUncommittedCostToComplete))
  const rollups = forecastRollups(rows)
  const adj = appliedSupplierVariationAdjustments(variations, purchaseOrders)
  const superseded = invoicedClaimIds(supplierInvoices)
  const byLine = remainingCommittedByPoLine(purchaseOrders, postedInvoicedByPoLine(supplierInvoices), recognisedClaimsByPoLine(progressClaims, superseded), adj.byPoLine)
  return {
    rows: Object.fromEntries(rows.map(r => [r.costCodeId, r])),
    rollups, adj, byLine,
    original: originalCommittedByCostCode(purchaseOrders),
    revised: committedByCostCode(purchaseOrders, adj.byPoLine),
    unapplied: unappliedSupplierVariationsByCostCode(variations, purchaseOrders),
    gross: approvedSupplierVariationsByCostCode(variations),
  }
}

// ── The worked cases ─────────────────────────────────────────────────────────

describe('case A — PO 100,000 + applied SV +12,000, no claims or invoices', () => {
  const p = position({ variations: [applied('a', [svLine(12_000)])] })

  it('original 100,000 → revised 112,000; remaining 112,000; Actual 0; FFC 112,000 + CTC; no separate exposure', () => {
    expect(p.original).toEqual({ X: 100_000 })
    expect(p.revised).toEqual({ X: 112_000 })
    expect(p.byLine.po1).toEqual({ 0: 112_000 })
    expect(p.rows.X).toMatchObject({ remainingCommitted: 112_000, actual: 0, appliedSupplierVariations: 12_000, unappliedSupplierVariations: 0, approvedSupplierVariations: 12_000 })
    expect(p.rows.X.forecastFinalCost).toBe(112_000)   // CTC null → 0
    expect(p.unapplied).toEqual({})
  })

  it('nothing is counted twice: gross approved == applied + unapplied, and FFC == Actual + Remaining Committed + CTC', () => {
    expect(p.gross.X).toBe(p.adj.byCostCode.X + (p.unapplied.X || 0))
    expect(p.rollups.forecastFinalCost).toBe(p.rollups.actual + p.rollups.remainingCommitted + p.rollups.uncommittedCostToComplete)
    expect(p.rollups.approvedSupplierVariations).toBe(p.rollups.appliedSupplierVariations + p.rollups.unappliedSupplierVariations)
  })

  it('the same SV UNAPPLIED (legacy) leaves every pre-ADR-62 figure unchanged: remaining 100,000, exposure 12,000', () => {
    const legacy = position({ variations: [sv('a', [svLine(12_000)])] })
    expect(legacy.revised).toEqual({ X: 100_000 })
    expect(legacy.byLine.po1).toEqual({ 0: 100_000 })
    expect(legacy.rows.X).toMatchObject({ remainingCommitted: 100_000, appliedSupplierVariations: 0, unappliedSupplierVariations: 12_000, approvedSupplierVariations: 12_000, forecastFinalCost: 100_000 })
    expect(legacy.unapplied).toEqual({ X: 12_000 })
    // Commitment Exposure = Remaining Committed + unapplied, as the Budget page composes it.
    expect(legacy.rows.X.remainingCommitted + legacy.rows.X.unappliedSupplierVariations).toBe(112_000)
  })
})

describe('case B — 5,000 of the variation work is claimed and approved', () => {
  const cl = claim('b', 5_000)
  const p = position({ variations: [applied('a', [svLine(12_000)])], progressClaims: [cl] })

  it('remaining 107,000; Actual 5,000; FFC still 112,000 — the claim moved a dollar from Committed to Actual, once', () => {
    expect(p.byLine.po1).toEqual({ 0: 107_000 })
    expect(p.rows.X).toMatchObject({ remainingCommitted: 107_000, actual: 5_000, forecastFinalCost: 112_000, approvedClaimsAwaitingInvoice: 5_000 })
  })
})

describe('case C — the whole 112,000 is claimed, approved, invoiced and posted', () => {
  const cl = claim('c', 112_000)
  const inv = claimInvoice('c', cl, 112_000)
  const claimed = position({ variations: [applied('a', [svLine(12_000)])], progressClaims: [cl] })
  const invoiced = position({ variations: [applied('a', [svLine(12_000)])], progressClaims: [cl], supplierInvoices: [inv] })

  it('after approval: remaining 0, Actual 112,000, FFC 112,000', () => {
    expect(claimed.byLine.po1).toEqual({ 0: 0 })
    expect(claimed.rows.X).toMatchObject({ remainingCommitted: 0, actual: 112_000, forecastFinalCost: 112_000 })
  })

  it('posting the claim-sourced invoice moves nothing: the invoice replaces the claim in Actual and the line stays at 0 (no double subtraction)', () => {
    expect(invoiced.byLine.po1).toEqual({ 0: 0 })
    expect(invoiced.rows.X).toMatchObject({ remainingCommitted: 0, actual: 112_000, forecastFinalCost: 112_000, approvedClaimsAwaitingInvoice: 0 })
    expect(actualClaimsByCostCode([cl], invoicedClaimIds([inv]))).toEqual({})
    expect(invoicedByCostCode([inv])).toEqual({ X: 112_000 })
  })

  it('over-claiming beyond the revised ceiling floors the line at 0 and never goes negative', () => {
    const over = position({ variations: [applied('a', [svLine(12_000)])], progressClaims: [claim('o', 120_000)] })
    expect(over.byLine.po1).toEqual({ 0: 0 })
    expect(over.rows.X).toMatchObject({ remainingCommitted: 0, actual: 120_000, forecastFinalCost: 120_000 })
  })
})

describe('case D — a NEGATIVE applied SV −8,000', () => {
  const p = position({ variations: [applied('d', [svLine(-8_000)])] })

  it('revised 92,000; remaining 92,000; no credit note, no Actual offset, nothing clamped at the line value', () => {
    expect(p.revised).toEqual({ X: 92_000 })
    expect(p.byLine.po1).toEqual({ 0: 92_000 })
    expect(p.rows.X).toMatchObject({ remainingCommitted: 92_000, actual: 0, appliedSupplierVariations: -8_000, forecastFinalCost: 92_000 })
    expect(revisedLineTotal(PO.lineItems[0], -8_000)).toBe(92_000)
  })

  it('with 95,000 already recognised the line floors at 0 and Actual stays 95,000 — the excess is visible, never offset', () => {
    const q = position({ variations: [applied('d', [svLine(-8_000)])], progressClaims: [claim('d', 95_000)] })
    expect(q.byLine.po1).toEqual({ 0: 0 })
    expect(q.rows.X).toMatchObject({ remainingCommitted: 0, actual: 95_000 })
  })

  it('a reduction below the original line value is a listed exception, still netted (floored), never silently zeroed', () => {
    const q = position({ variations: [applied('d', [svLine(-110_000)])] })
    expect(q.adj.exceptions.map(e => [e.kind, e.poLineIndex, e.amount])).toEqual([['negative_revised_line', 0, -10_000]])
    expect(q.adj.byPoLine.po1).toEqual({ 0: -110_000 })
    expect(q.byLine.po1).toEqual({ 0: 0 })
    expect(q.revised).toEqual({ X: -10_000 })   // the contractual figure is signed; Remaining Committed floors
  })
})

describe('case E — 40,000 claimed and approved BEFORE the variation is approved and applied', () => {
  const before = position({ progressClaims: [claim('e', 40_000)] })
  const after = position({ progressClaims: [claim('e', 40_000)], variations: [applied('e', [svLine(12_000)])] })

  it('remaining 60,000 → 72,000; Actual 40,000 unchanged; the existing claim is untouched', () => {
    expect(before.byLine.po1).toEqual({ 0: 60_000 })
    expect(after.byLine.po1).toEqual({ 0: 72_000 })
    expect(after.rows.X).toMatchObject({ remainingCommitted: 72_000, actual: 40_000, forecastFinalCost: 112_000 })
  })
})

describe('several variations and several lines', () => {
  it('two applied variations on one PO line aggregate once each: +12,000 and −3,000 → revised 109,000', () => {
    const p = position({ variations: [applied('p', [svLine(12_000)]), applied('n', [svLine(-3_000)])] })
    expect(p.adj.byPoLine.po1).toEqual({ 0: 9_000 })
    expect(p.revised).toEqual({ X: 109_000 })
    expect(p.byLine.po1).toEqual({ 0: 109_000 })
  })

  it('the SAME variation document listed twice (a duplicated snapshot) is counted once', () => {
    const v = applied('dup', [svLine(12_000)])
    const p = position({ variations: [v, { ...v }] })
    expect(p.adj.byPoLine.po1).toEqual({ 0: 12_000 })
    expect(Object.keys(p.adj.incorporations)).toEqual(['dup'])
  })

  it('several PO lines and cost codes: each line\'s adjustment is attributed to THAT PO line\'s cost code', () => {
    const v = applied('m', [
      svLine(1_000, { costCodeId: 'Y', costCodeName: '03-200 — Formwork', poLineIndex: 0 }),
      svLine(-500, { costCodeId: 'Z', costCodeName: '03-100 — Concrete', poLineIndex: 1 }),
    ], { poId: 'po2', poNumber: 'PO-0002' })
    const p = position({ purchaseOrders: [PO, PO2], variations: [v], budgetLines: [] })
    expect(p.adj.byPoLine).toEqual({ po2: { 0: 1_000, 1: -500 } })
    expect(p.adj.byCostCode).toEqual({ Y: 1_000, Z: -500 })
    expect(p.revised).toEqual({ X: 100_000, Y: 31_000, Z: 19_500 })
    expect(remainingCommittedByCostCode([PO, PO2], {}, {}, p.adj.byPoLine)).toEqual({ X: 100_000, Y: 31_000, Z: 19_500 })
    expect(revisedCommitmentByPoLine([PO2], p.adj.byPoLine).po2).toEqual({
      0: { original: 30_000, adjustment: 1_000, revised: 31_000 },
      1: { original: 20_000, adjustment: -500, revised: 19_500 },
    })
  })
})

describe('new-scope and mixed variations', () => {
  const mixed = applied('mx', [svLine(12_000), svLine(4_000, { poLineIndex: null, costCodeId: 'W', costCodeName: '09-100 — Paint', description: 'Painting (new scope)' })])
  const newOnly = applied('ns', [svLine(4_000, { poLineIndex: null, costCodeId: 'W', costCodeName: '09-100 — Paint' })])

  it('a mixed variation is PARTIALLY incorporated: 12,000 matures, 4,000 stays as unapplied exposure on its own cost code — gross, incorporated and outstanding shown apart from the stamp', () => {
    const inc = variationIncorporation(mixed, [PO])
    expect(inc.state).toBe(INCORPORATION_STATE.PARTIAL)
    expect(INCORPORATION_STATE_LABELS[inc.state]).toBe('Partially incorporated')
    expect(inc).toMatchObject({ applied: true, gross: 16_000, matured: 12_000, outstanding: 4_000, newScope: 4_000, invalid: 0, counts: { existing: 1, newScope: 1, invalid: 0 } })
    const p = position({ variations: [mixed] })
    expect(p.byLine.po1).toEqual({ 0: 112_000 })
    expect(p.unapplied).toEqual({ W: 4_000 })
    expect(p.rows.W).toMatchObject({ remainingCommitted: 0, unappliedSupplierVariations: 4_000, approvedSupplierVariations: 4_000, appliedSupplierVariations: 0 })
    expect(p.gross).toEqual({ X: 12_000, W: 4_000 })
    expect(p.rollups.approvedSupplierVariations).toBe(p.rollups.appliedSupplierVariations + p.rollups.unappliedSupplierVariations)
  })

  it('a new-scope-only variation carries the applied stamp but, with no scope commit, is NEW SCOPE AWAITING COMMIT — never "fully incorporated": nothing matures, the whole amount stays exposure, nothing disappears', () => {
    const inc = variationIncorporation(newOnly, [PO])
    expect(inc.state).toBe(INCORPORATION_STATE.NOT_INCORPORATED)
    expect(INCORPORATION_STATE_LABELS[inc.state]).toBe('New scope awaiting commit')
    expect(inc.scopeCommitted).toBe(false)
    expect(inc).toMatchObject({ applied: true, gross: 4_000, matured: 0, outstanding: 4_000 })
    const p = position({ variations: [newOnly] })
    expect(p.adj.byPoLine).toEqual({})
    expect(p.byLine.po1).toEqual({ 0: 100_000 })
    expect(p.unapplied).toEqual({ W: 4_000 })
    expect(unappliedSupplierVariationsTotal([newOnly], [PO])).toBe(4_000)
    expect(appliedSupplierVariationsTotal([newOnly], [PO])).toBe(0)
  })
})

describe('invalid links are flagged, never counted against another line or cost code', () => {
  it('out-of-range index, cost-code mismatch, cancelled PO, missing PO and a non-numeric amount are INVALID with the exact issue', () => {
    const outOfRange = applied('r', [svLine(100, { poLineIndex: 4 })])
    const mismatch = applied('c', [svLine(100, { costCodeId: 'Q', costCodeName: 'Wrong code' })])
    const onCancelled = applied('k', [svLine(100)])
    const missing = applied('g', [svLine(100)], { poId: 'po_gone', poNumber: 'PO-0099' })
    const junk = applied('j', [svLine(100, { approvedAmount: 'abc' })])
    const cancelledPo = { ...PO, status: PO_STATUS.CANCELLED }

    expect(classifyCommitmentLines(outOfRange, PO)[0]).toMatchObject({ kind: COMMITMENT_LINE_KIND.INVALID, issue: COMMITMENT_LINE_ISSUE.LINE_OUT_OF_RANGE })
    expect(classifyCommitmentLines(mismatch, PO)[0]).toMatchObject({ kind: COMMITMENT_LINE_KIND.INVALID, issue: COMMITMENT_LINE_ISSUE.COST_CODE_MISMATCH, costCodeId: 'Q', poLineCostCodeId: 'X' })
    expect(classifyCommitmentLines(onCancelled, cancelledPo)[0]).toMatchObject({ kind: COMMITMENT_LINE_KIND.INVALID, issue: COMMITMENT_LINE_ISSUE.PO_NOT_COMMITTED })
    expect(classifyCommitmentLines(missing, null)[0]).toMatchObject({ kind: COMMITMENT_LINE_KIND.INVALID, issue: COMMITMENT_LINE_ISSUE.PO_MISSING })
    expect(classifyCommitmentLines(junk, PO)[0]).toMatchObject({ kind: COMMITMENT_LINE_KIND.INVALID, issue: COMMITMENT_LINE_ISSUE.AMOUNT_INVALID, amount: null })

    const adj = appliedSupplierVariationAdjustments([outOfRange, mismatch, missing, junk], [PO])
    expect(adj.byPoLine).toEqual({})
    expect(adj.byCostCode).toEqual({})
    expect(adj.exceptions.map(e => e.issue).sort()).toEqual(['amount_invalid', 'cost_code_mismatch', 'line_out_of_range', 'po_missing'])
    for (const id of ['r', 'c', 'g', 'j']) expect(adj.incorporations[id].state).toBe(INCORPORATION_STATE.EXCEPTION)
    // The amounts stay in unapplied exposure on the LINE's own cost code (never X for the mismatch).
    expect(unappliedSupplierVariationsByCostCode([outOfRange, mismatch, missing, junk], [PO])).toEqual({ X: 200, Q: 100 })
    expect(remainingCommittedByPoLine([PO], {}, {}, adj.byPoLine).po1).toEqual({ 0: 100_000 })
  })

  it('a variation applied to a PO that is later cancelled matures nothing and is an exception — its exposure does not vanish', () => {
    const v = applied('k', [svLine(12_000)])
    const cancelled = { ...PO, status: PO_STATUS.CANCELLED }
    const adj = appliedSupplierVariationAdjustments([v], [cancelled])
    expect(adj.byPoLine).toEqual({})
    expect(adj.exceptions[0]).toMatchObject({ issue: 'po_not_committed', amount: 12_000, poStatus: 'cancelled' })
    expect(unappliedSupplierVariationsByCostCode([v], [cancelled])).toEqual({ X: 12_000 })
    expect(variationIncorporation(v, [cancelled]).state).toBe(INCORPORATION_STATE.EXCEPTION)
  })

  it('a valid line on the same variation still matures while the invalid one is listed', () => {
    const v = applied('h', [svLine(12_000), svLine(50, { poLineIndex: 9 })])
    const adj = appliedSupplierVariationAdjustments([v], [PO])
    expect(adj.byPoLine).toEqual({ po1: { 0: 12_000 } })
    expect(adj.exceptions).toHaveLength(1)
    expect(adj.incorporations.h).toMatchObject({ state: INCORPORATION_STATE.EXCEPTION, matured: 12_000, invalid: 50 })
  })
})

describe('eligibility, the approve-time decision and the stamp predicates', () => {
  const approvedLinked = sv('a', [svLine(1)])

  it('isCommitmentApplied requires BOTH stamps; isPoLinkedSupplierVariation requires a supplier with a string poId', () => {
    expect(VARIATION_COMMITMENT_KEYS).toEqual(['commitmentAppliedAt', 'commitmentAppliedBy'])
    expect(isCommitmentApplied(applied('x', []))).toBe(true)
    expect(isCommitmentApplied({ commitmentAppliedAt: { seconds: 1 } })).toBe(false)
    expect(isCommitmentApplied({ commitmentAppliedBy: 'u' })).toBe(false)
    expect(isCommitmentApplied({})).toBe(false)
    expect(isPoLinkedSupplierVariation(approvedLinked)).toBe(true)
    expect(isPoLinkedSupplierVariation({ ...approvedLinked, poId: null })).toBe(false)
    expect(isPoLinkedSupplierVariation({ ...approvedLinked, variationType: 'client' })).toBe(false)
  })

  it('every blocker, in order: not supplier, manual mode, not approved, already applied, PO missing, PO not committed — and the ADR-63 missing-pair report', () => {
    const b = (v, pos = [PO]) => commitmentApplyEligibility(v, pos).blocker
    expect(b({ ...approvedLinked, variationType: 'client' })).toBe(COMMITMENT_APPLY_BLOCKER.NOT_SUPPLIER)
    expect(b({ ...approvedLinked, poId: null })).toBe(COMMITMENT_APPLY_BLOCKER.MANUAL_MODE)
    expect(b({ ...approvedLinked, status: 'submitted' })).toBe(COMMITMENT_APPLY_BLOCKER.NOT_APPROVED)
    expect(b({ ...approvedLinked, status: 'rejected' })).toBe(COMMITMENT_APPLY_BLOCKER.NOT_APPROVED)
    // Applied with existing-line amounts only: nothing further to record.
    expect(b(applied('a', [svLine(1)]))).toBe(COMMITMENT_APPLY_BLOCKER.ALREADY_APPLIED)
    // Applied AND scope-committed: nothing further to record either.
    expect(b(applied('a', [svLine(1), svLine(500, { poLineIndex: null })], SCOPE))).toBe(COMMITMENT_APPLY_BLOCKER.ALREADY_APPLIED)
    expect(b(approvedLinked, [])).toBe(COMMITMENT_APPLY_BLOCKER.PO_MISSING)
    expect(b(approvedLinked, [{ ...PO, status: 'cancelled' }])).toBe(COMMITMENT_APPLY_BLOCKER.PO_NOT_COMMITTED)
    expect(b(approvedLinked, [{ ...PO, status: 'draft' }])).toBe(COMMITMENT_APPLY_BLOCKER.PO_NOT_COMMITTED)
    // Never applied: the legacy Apply writes both pairs.
    expect(commitmentApplyEligibility(approvedLinked, [PO])).toMatchObject({ eligible: true, blocker: null, po: PO, missing: { applied: true, scope: true } })
    expect(commitmentApplyEligibility(approvedLinked, [{ ...PO, status: 'closed' }]).eligible).toBe(true)
    // Applied under M3-B1 with a positive new-scope line: the scope pair only ("Commit new scope").
    const b1Applied = applied('b1', [svLine(1), svLine(500, { poLineIndex: null, costCodeId: 'W' })])
    expect(commitmentApplyEligibility(b1Applied, [PO])).toMatchObject({ eligible: true, missing: { applied: false, scope: true } })
    // …but a NEGATIVE new-scope line alone is nothing to commit.
    expect(b(applied('b1n', [svLine(1), svLine(-500, { poLineIndex: null, costCodeId: 'W' })]))).toBe(COMMITMENT_APPLY_BLOCKER.ALREADY_APPLIED)
    // The PO blockers still decide for a scope-only commit.
    expect(b(b1Applied, [{ ...PO, status: 'cancelled' }])).toBe(COMMITMENT_APPLY_BLOCKER.PO_NOT_COMMITTED)
  })

  it('shouldApplyOnApproval: PO-linked supplier + sent/closed PO only', () => {
    expect(shouldApplyOnApproval(approvedLinked, PO)).toBe(true)
    expect(shouldApplyOnApproval(approvedLinked, { ...PO, status: 'closed' })).toBe(true)
    expect(shouldApplyOnApproval(approvedLinked, { ...PO, status: 'cancelled' })).toBe(false)
    expect(shouldApplyOnApproval(approvedLinked, null)).toBe(false)
    expect(shouldApplyOnApproval({ ...approvedLinked, poId: null }, PO)).toBe(false)
    expect(shouldApplyOnApproval({ ...approvedLinked, variationType: 'client' }, PO)).toBe(false)
  })

  it('the five presentation states separate the process stamp from the amount incorporated (Correction C)', () => {
    expect(variationIncorporation({ ...approvedLinked, variationType: 'client' }, [PO]).state).toBe(INCORPORATION_STATE.NOT_APPLICABLE)
    expect(variationIncorporation({ ...approvedLinked, poId: null }, [PO]).state).toBe(INCORPORATION_STATE.NOT_APPLICABLE)
    expect(variationIncorporation({ ...approvedLinked, status: 'submitted' }, [PO]).state).toBe(INCORPORATION_STATE.NOT_APPROVED)
    // 4 · Not yet applied: legacy approved, no stamps — gross is all outstanding.
    const legacy = variationIncorporation(sv('l', [svLine(12_000)]), [PO])
    expect(legacy).toMatchObject({ state: INCORPORATION_STATE.UNAPPLIED, applied: false, gross: 12_000, matured: 0, outstanding: 12_000 })
    expect(INCORPORATION_STATE_LABELS[legacy.state]).toBe('Not yet applied')
    // 1 · Fully incorporated: every approved amount is in the revised commitment (positive and negative kept signed).
    const full = variationIncorporation(applied('i', [svLine(12_000), svLine(-3_000)]), [PO])
    expect(full).toMatchObject({ state: INCORPORATION_STATE.INCORPORATED, applied: true, gross: 9_000, matured: 9_000, outstanding: 0 })
    expect(INCORPORATION_STATE_LABELS[full.state]).toBe('Fully incorporated')
    // 5 · Invalid / exception: a stamped variation with a broken line.
    const bad = variationIncorporation(applied('x', [svLine(12_000), svLine(50, { poLineIndex: 9 })]), [PO])
    expect(bad).toMatchObject({ state: INCORPORATION_STATE.EXCEPTION, applied: true, gross: 12_050, matured: 12_000, outstanding: 50, invalid: 50 })
    expect(INCORPORATION_STATE_LABELS[bad.state]).toBe('Invalid — needs review')
    // A negative new-scope line keeps its sign in the outstanding exposure and
    // names its own review state (ADR-63): it is never matured or claimed.
    const negNew = variationIncorporation(applied('n', [svLine(12_000), svLine(-2_000, { poLineIndex: null, costCodeId: 'W' })]), [PO])
    expect(negNew).toMatchObject({ state: INCORPORATION_STATE.NEGATIVE_NEW_SCOPE, gross: 10_000, matured: 12_000, outstanding: -2_000, negativeNewScope: -2_000 })
    expect(INCORPORATION_STATE_LABELS[negNew.state]).toBe('Negative new scope — review')
    // …even once the scope commit is recorded: the negative line still matures nothing.
    const negNewCommitted = variationIncorporation(applied('nc', [svLine(12_000), svLine(-2_000, { poLineIndex: null, costCodeId: 'W' })], SCOPE), [PO])
    expect(negNewCommitted).toMatchObject({ state: INCORPORATION_STATE.NEGATIVE_NEW_SCOPE, matured: 12_000, outstanding: -2_000, committedNewScope: 0 })
  })
})

describe('the commercial-effect preview (Assess and legacy Apply)', () => {
  const prior = applied('prior', [svLine(2_000)])        // already applied: current revised 102,000
  const candidate = sv('cand', [svLine(12_000), svLine(4_000, { poLineIndex: null, costCodeId: 'W', costCodeName: '09-100 — Paint' })])
  const base = { variation: candidate, purchaseOrders: [PO], progressClaims: [claim('p', 40_000)], supplierInvoices: [], variations: [prior, candidate], forecastLines: [] }

  it('per PO line: current value (incl. other applied SVs), recognised, remaining now, delta, revised and remaining after', () => {
    const pv = commitmentEffectPreview(base)
    expect(pv).toMatchObject({ applicable: true, poState: PO_LINK_STATE.COMMITTED, willApply: true })
    expect(pv.poLines).toEqual([{
      poLineIndex: 0, costCodeId: 'X', costCodeName: '05-200 — Steel', description: 'Structural steel',
      original: 100_000, currentAdjustment: 2_000, currentRevised: 102_000, recognised: 40_000, currentRemaining: 62_000,
      delta: 12_000, revisedAfter: 114_000, remainingAfter: 74_000, negativeAfter: false, overRecognised: false,
    }])
    expect(pv.newScope.map(l => l.amount)).toEqual([4_000])
    // ADR-63: approving commits the 4,000 positive new-scope line too, so it is
    // part of what matures; the new-scope totals are reported apart.
    expect(pv).toMatchObject({ willCommitScope: true, alreadyScopeCommitted: false, overRecognitionWarning: false })
    expect(pv.totals).toEqual({ matured: 16_000, newScope: 4_000, newScopeCommittable: 4_000, newScopeNegative: 0, invalid: 0, remainingBefore: 62_000, remainingAfter: 74_000 })
    // Already scope-committed: the new scope is not counted as maturing again.
    const already = commitmentEffectPreview({ ...base, variation: { ...candidate, ...APPLIED, ...SCOPE } })
    expect(already).toMatchObject({ willCommitScope: false, alreadyScopeCommitted: true })
    expect(already.totals.matured).toBe(12_000)
  })

  it('CTC warning only when a POSITIVE saved Uncommitted CTC sits on an affected cost code and the variation will apply; never a proof', () => {
    expect(commitmentEffectPreview({ ...base, forecastLines: [{ id: 'X', costCodeId: 'X', uncommittedCostToComplete: 12_000 }] })).toMatchObject({
      ctcWarning: true, costCodes: [{ costCodeId: 'X', delta: 12_000, uncommittedCtc: 12_000, ctcWarning: true }, { costCodeId: 'W', delta: 4_000, uncommittedCtc: null, ctcWarning: false }],
    })
    expect(commitmentEffectPreview({ ...base, forecastLines: [{ id: 'X', costCodeId: 'X', uncommittedCostToComplete: 0 }] }).ctcWarning).toBe(false)
    expect(commitmentEffectPreview({ ...base, forecastLines: [{ id: 'X', costCodeId: 'X', uncommittedCostToComplete: null }] }).ctcWarning).toBe(false)
    // ADR-63: the NEW-SCOPE code (W) IS an affected code once the approve commits the new scope.
    expect(commitmentEffectPreview({ ...base, forecastLines: [{ id: 'W', costCodeId: 'W', uncommittedCostToComplete: 999 }] }).ctcWarning).toBe(true)
    // …but not when the scope is already committed (nothing new enters commitment on W).
    expect(commitmentEffectPreview({ ...base, variation: { ...candidate, ...APPLIED, ...SCOPE }, forecastLines: [{ id: 'W', costCodeId: 'W', uncommittedCostToComplete: 999 }] }).ctcWarning).toBe(false)
    // A cancelled PO: nothing applies, so nothing can overlap.
    const cancelled = commitmentEffectPreview({ ...base, purchaseOrders: [{ ...PO, status: 'cancelled' }], forecastLines: [{ id: 'X', costCodeId: 'X', uncommittedCostToComplete: 12_000 }] })
    expect(cancelled).toMatchObject({ poState: PO_LINK_STATE.NOT_COMMITTED, willApply: false, ctcWarning: false })
    expect(cancelled.totals.matured).toBe(0)
  })

  it('a missing PO, a client variation and a manual-mode variation', () => {
    expect(commitmentEffectPreview({ ...base, purchaseOrders: [] })).toMatchObject({ applicable: true, poState: PO_LINK_STATE.MISSING, willApply: false, poLines: [] })
    expect(commitmentEffectPreview({ ...base, variation: { ...candidate, variationType: 'client' } }).applicable).toBe(false)
    expect(commitmentEffectPreview({ ...base, variation: { ...candidate, poId: null } })).toMatchObject({ applicable: false, poState: PO_LINK_STATE.NONE })
  })

  it('a negative candidate below the current revised value flags the line', () => {
    const pv = commitmentEffectPreview({ ...base, variation: sv('neg', [svLine(-150_000)]) })
    expect(pv.poLines[0]).toMatchObject({ delta: -150_000, revisedAfter: -48_000, remainingAfter: 0, negativeAfter: true })
  })
})

describe('Forecast, Margin, Dashboard snapshot, Cash Flow and PULSE carry the one adjustment consistently', () => {
  const variations = [applied('a', [svLine(12_000)]), sv('legacy', [svLine(3_000)])]
  const sources = {
    budgetLines: [{ id: 'X', costCodeId: 'X', budgeted: 150_000 }], purchaseOrders: [PO], progressClaims: [claim('b', 5_000)],
    supplierInvoices: [], supplierCreditNotes: [], variations, forecastLines: [{ id: 'X', costCodeId: 'X', uncommittedCostToComplete: 1_000 }],
    baseline: { originalContractValue: 200_000, originalApprovedBudget: 150_000 },
  }
  const { baseline, ...forecastSources } = sources
  const totals = projectForecastTotals(forecastSources)
  const m = computeMargin({ baseline, variations, forecastFinalCost: totals.forecastFinalCost, purchaseOrders: [PO] })

  it('rollups: remaining 107,000 (revised 112,000 − 5,000 claimed), applied 12,000, unapplied 3,000, gross 15,000, FFC = 5,000 + 107,000 + 1,000', () => {
    expect(totals).toMatchObject({ remainingCommitted: 107_000, actual: 5_000, appliedSupplierVariations: 12_000, unappliedSupplierVariations: 3_000, approvedSupplierVariations: 15_000, forecastFinalCost: 113_000 })
  })

  it('margin carries the same split and the same FFC; without the PO register every applied variation reads as unapplied (conservative)', () => {
    expect(m).toMatchObject({ appliedSupplierVariations: 12_000, unappliedSupplierVariations: 3_000, approvedSupplierVariations: 15_000, forecastFinalCost: 113_000 })
    expect(m.forecastGrossProfit).toBe(200_000 - 113_000)
    const noRegister = computeMargin({ baseline, variations, forecastFinalCost: totals.forecastFinalCost })
    expect(noRegister).toMatchObject({ appliedSupplierVariations: 0, unappliedSupplierVariations: 15_000 })
  })

  it('the Dashboard snapshot is the same selector output, and a failed or loading variations read makes Remaining Committed and FFC UNAVAILABLE / loading — never a settled zero adjustment', () => {
    const settled = Object.fromEntries(SNAPSHOT_SOURCES.map(s => [s, { loading: false, error: false }]))
    const snap = projectSnapshot({ sources: { ...sources, supplierPayments: [], retentionReleases: [] }, sourceStates: settled, currencyCode: 'AUD' })
    expect(snap.remainingCommitted.value).toBe(107_000)
    expect(snap.forecastFinalCost.value).toBe(113_000)
    for (const key of ['remainingCommitted', 'forecastFinalCost', 'varianceToBudget', 'costComposition', 'commitmentExposure', 'closedResidual', 'supplierVariationExposure', 'appliedSupplierVariations']) {
      expect(FIGURE_DEPENDENCIES[key], key).toContain('variations')
      expect(availableFigure(key, 1, { ...settled, variations: { loading: false, error: true } }).state).toBe(FIGURE_STATE.UNAVAILABLE)
      expect(availableFigure(key, 1, { ...settled, variations: { loading: true, error: false } }).state).toBe(FIGURE_STATE.LOADING)
    }
    expect(FIGURE_DEPENDENCIES.actual).not.toContain('variations')   // Actual never reads a variation
  })

  it('Cash Flow\'s cost denominator (Remaining Committed + uninvoiced claims + CTC) rises by exactly the applied amount and never adds the variation again', () => {
    const without = projectForecastTotals({ ...forecastSources, variations: [sv('legacy', [svLine(3_000)])] })
    const basis = (t) => t.remainingCommitted + t.approvedClaimsAwaitingInvoice + t.uncommittedCostToComplete
    expect(basis(totals)).toBe(107_000 + 5_000 + 1_000)
    expect(basis(totals) - basis(without)).toBe(12_000)
    // 11,300 of remaining-committed coverage is exactly 10% of the 113,000 basis.
    const line = { status: 'active', sourceType: 'remaining_committed', sourceAmountExGst: 11_300 }
    const cov = (t) => costCoverage({ remainingCommittedTotal: t.remainingCommitted, uninvoicedClaimTotal: t.approvedClaimsAwaitingInvoice, uncommittedCtcTotal: t.uncommittedCostToComplete, unforecastedCount: t.unforecastedCount, lines: [line] })
    expect(cov(totals).pct).toBe(10)
    expect(cov(without).pct).toBe(11.19)   // 11,300 / 101,000
  })

  it('PULSE indicators 1 and 3 read the adjusted FFC; indicator 6 (pending) is untouched by applied variations', () => {
    const states = Object.fromEntries(PULSE_SOURCES.map(s => [s, { loading: false, error: false }]))
    const pulse = evaluatePulse({ sources: { ...sources, supplierPayments: [], retentionReleases: [], activities: [] }, sourceStates: states, currencyCode: 'AUD' })
    const over = pulse.indicators.find(i => i.id === INDICATOR.FORECAST_OVER_BUDGET)
    expect(over.values.forecastFinalCost).toBe(113_000)
    const pending = pulse.indicators.find(i => i.id === INDICATOR.PENDING_VARIATION_EXPOSURE)
    expect(pending.values.supplier.exposure).toBe(0)
  })
})
