import { describe, it, expect } from 'vitest'
import {
  classifyCommitmentLines, variationIncorporation, unappliedSupplierVariationsByCostCode,
  approvedSupplierVariationsByCostCode, committedNewScopeTotal, remainingCommittedByVariationLine, remainingCommittedNewScopeByCostCode,
  claimableNewScopeLines, commitmentApplyEligibility, isScopeCommitted, SCOPE_COMMITMENT_KEYS,
  COMMITMENT_LINE_KIND, COMMITMENT_LINE_ISSUE, INCORPORATION_STATE, COMMITMENT_APPLY_BLOCKER,
} from '../../src/lib/variations'
import { committedByCostCode, PO_STATUS } from '../../src/lib/purchaseOrders'
import {
  buildClaimLine, buildVariationClaimLine, claimLineCeiling, claimVariationLineCount, validateClaimDraft,
  previouslyApprovedByPoLine, previouslyApprovedByVariationLine, recognisedClaimsByPoLine, recognisedClaimsByVariationLine,
  actualClaimsByCostCode, claimedPoLines, variationOriginClaimLines, claimVariationLineIssue, CLAIM_VARIATION_LINE_ISSUE,
  CLAIM_STATUS,
} from '../../src/lib/progressClaims'
import { variationSourceError, transitionUpdate as claimTransitionUpdate, draftUpdate as claimDraftUpdate } from '../../src/lib/progressClaimActions'
import {
  buildInvoiceLine, invoiceVariationLineCount, postedInvoicedByPoLine, postedInvoicedByVariationLine, postedInvoicedByPo,
  directInvoicedPoLines, invoicedClaimIds, invoicedByCostCode, invoiceTotals, SI_STATUS, SI_SOURCE,
} from '../../src/lib/supplierInvoices'
import { remainingCommitment, closedResidualCommitment } from '../../src/lib/commitment'
import { buildForecastRows, composeForecastRow, forecastRollups } from '../../src/lib/forecast'
import { projectForecastTotals, computeMargin } from '../../src/lib/margin'
import { projectSnapshot, FIGURE_DEPENDENCIES, SNAPSHOT_SOURCES } from '../../src/lib/projectSnapshot'
import { costCoverage, classifyInvoiceBalances, totalActualCashOut } from '../../src/lib/cashFlow'
import { payablesSummary, supplierInvoiceReconciliationRows, cashOutRows } from '../../src/lib/supplierPayments'
import { creditedByCostCode, creditTargetException } from '../../src/lib/supplierCreditNotes'
import { evaluatePulse, INDICATOR, PULSE_SOURCES } from '../../src/lib/pulse'
import { evaluateShield, SHIELD_SOURCES, CHECK, STATE_CONFLICT, SHIELD_STATE } from '../../src/lib/shield'
import { commitmentEffectPreview } from '../../src/lib/variationCommitment'
import { sourceLineKind, SOURCE_LINE_KIND } from '../../src/lib/sourceLine'

// ── M3-B2 (ADR-63): new-scope variation lines → claims → invoices → Actual ───
//
// The brief's numerical invariants, run through the REAL selectors. Fixture:
//   · sent PO 100,000, one line, cost code X
//   · SV-0001  existing-line +12,000, applied (+ scope-committed — no new scope)
//   · SV-0002  new-scope    +4,000 on cost code X, applied + scope-committed
//   · budget 150,000, Uncommitted CTC 10,000
//
//   before claims                   revised 116,000 · remaining 116,000 · Actual 0     · FFC 126,000
//   claim 2,000 on SV-0002 line     remaining 114,000 · Actual 2,000 · awaiting 2,000 · FFC 126,000
//   its invoice posted              remaining 114,000 · Actual 2,000 · awaiting 0     · FFC 126,000
//   second claim 1,500 approved     remaining 112,500 · Actual 3,500 · awaiting 1,500 · FFC 126,000
//   third claim 1,000 approved      line floors at 0 · remaining 112,000 · Actual 4,500 · FFC 126,500 · SHIELD lists 500
//                                   (awaiting 2,500 while the second claim is uninvoiced; 1,000 once its invoice posts)

const T  = { seconds: 1_700_000_000, nanoseconds: 0 }
const APPLIED = { commitmentAppliedAt: T, commitmentAppliedBy: 'u_qs' }
const SCOPE   = { scopeCommittedAt: T, scopeCommittedBy: 'u_qs' }

const PO = {
  id: 'po1', poNumber: 'PO-0001', status: PO_STATUS.SENT, supplierId: 'sup1', supplierName: 'Steel Co', subtotal: 100_000,
  lineItems: [{ costCodeId: 'X', costCodeName: '05-200 — Steel', description: 'Structural steel', qty: 1, unit: '', unitPrice: 100_000, lineTotal: 100_000 }],
}
const svLine = (amount, over = {}) => ({
  costCodeId: 'X', costCodeName: '05-200 — Steel', description: 'Extra steel',
  submittedAmount: amount, submittedGst: amount / 10, approvedAmount: amount, approvedGst: amount / 10, poLineIndex: 0, taxCode: 'gst', ...over,
})
const newScopeLine = (amount, over = {}) => svLine(amount, { poLineIndex: null, description: 'New scope', ...over })
const sv = (id, number, lines, over = {}) => ({
  id, variationNumber: number, variationType: 'supplier', status: 'approved', poId: 'po1', poNumber: 'PO-0001',
  supplierId: 'sup1', supplierName: 'Steel Co', lineItems: lines,
  approvedSubtotal: lines.reduce((s, l) => s + (l.approvedAmount ?? 0), 0), ...over,
})
const SV1 = sv('sv1', 'SV-0001', [svLine(12_000)], { ...APPLIED, ...SCOPE })
const SV2 = sv('sv2', 'SV-0002', [newScopeLine(4_000)], { ...APPLIED, ...SCOPE })
const SV2_ROW = { variationId: 'sv2', variationNumber: 'SV-0002', lineIndex: 0, amount: 4_000, costCodeId: 'X', costCodeName: '05-200 — Steel', description: 'New scope' }

// A claim on PO-0001 with the PO line (claimed 0) and one variation-origin line.
const poLine0 = (toDate = 0, prev = 0) => buildClaimLine(PO.lineItems[0], { poLineIndex: 0, previouslyApproved: prev, claimedToDate: toDate })
const varClaimLine = (toDate, prev = 0, row = SV2_ROW) => buildVariationClaimLine(row, { previouslyApproved: prev, claimedToDate: toDate })
function claim(id, lines, approvedAmounts, over = {}) {
  const approved = lines.map((li, i) => ({ ...li, approvedThisPeriod: approvedAmounts[i] }))
  const subtotal = approvedAmounts.reduce((s, a) => s + a, 0)
  return {
    id, claimNumber: `PC-${id}`, status: CLAIM_STATUS.APPROVED, poId: 'po1', poNumber: 'PO-0001', variationId: null,
    variationLineCount: claimVariationLineCount(lines), lineItems: approved, retention: 0,
    claimedSubtotal: subtotal, approvedSubtotal: subtotal, approvedGst: subtotal / 10, approvedTotal: subtotal * 1.1, ...over,
  }
}
// The claim-sourced invoice exactly as the editor seeds it: the certified lines
// with a positive amount, identity carried, GST per line.
function invoiceFrom(cl, id, status = SI_STATUS.POSTED) {
  const lines = cl.lineItems.filter(li => li.approvedThisPeriod > 0).map(li => buildInvoiceLine(li, { amount: li.approvedThisPeriod, taxCode: 'gst' }))
  return {
    id, invoiceNumber: `SI-${id}`, supplierInvoiceNumber: `INV-${id}`, status, source: SI_SOURCE.PROGRESS_CLAIM, poId: 'po1', poNumber: 'PO-0001',
    supplierId: 'sup1', supplierName: 'Steel Co', currency: 'AUD',
    progressClaimId: cl.id, claimNumber: cl.claimNumber, variationLineCount: invoiceVariationLineCount(lines),
    lineItems: lines, dueDate: '2026-11-15', ...invoiceTotals(lines, 0),
  }
}

const CTC = 10_000
function position({ purchaseOrders = [PO], progressClaims = [], supplierInvoices = [], supplierCreditNotes = [], variations = [SV1, SV2], ctc = CTC, budget = 150_000 } = {}) {
  const sources = {
    costCodes: [{ id: 'X', code: '05-200', name: 'Steel', isActive: true }],
    budgetLines: [{ id: 'bX', costCodeId: 'X', budgeted: budget }],
    purchaseOrders, progressClaims, supplierInvoices, supplierCreditNotes, variations,
    forecastLines: [{ id: 'X', costCodeId: 'X', uncommittedCostToComplete: ctc }],
  }
  const rows = buildForecastRows(sources).map(r => composeForecastRow(r, r.storedUncommittedCostToComplete))
  const row = rows.find(r => r.costCodeId === 'X')
  const rollups = forecastRollups(rows)
  const rc = remainingCommitment({ purchaseOrders, progressClaims, supplierInvoices, variations })
  const revisedPo = committedByCostCode(purchaseOrders, rc.adjustments.byPoLine).X || 0
  const committedNewScope = rc.adjustments.committedNewScopeByCostCode.X || 0
  return {
    sources, row, rollups, rc,
    revisedCommitment: revisedPo + committedNewScope,            // contractual: PO lines revised + committed new scope
    remaining: row.remainingCommitted, actual: row.actual, ffc: row.forecastFinalCost,
    awaiting: row.approvedClaimsAwaitingInvoice, unapplied: row.unappliedSupplierVariations,
    varLineRemaining: rc.byVariationLine.sv2?.[0],
  }
}

// ── The worked cases ─────────────────────────────────────────────────────────

describe('case A — before any claim: committed new scope IS commitment', () => {
  const p = position()
  it('revised commitment 116,000 (112,000 PO + 4,000 new scope); Remaining Committed 116,000; Actual 0; FFC 126,000; nothing left as exposure', () => {
    expect(p.revisedCommitment).toBe(116_000)
    expect(p.remaining).toBe(116_000)
    expect(p.rc.byPoLine.po1).toEqual({ 0: 112_000 })
    expect(p.rc.byVariationLine).toEqual({ sv2: { 0: 4_000 } })
    expect(p.actual).toBe(0)
    expect(p.ffc).toBe(126_000)
    expect(p.unapplied).toBe(0)
    expect(p.row).toMatchObject({ appliedSupplierVariations: 12_000, committedNewScopeVariations: 4_000, approvedSupplierVariations: 16_000 })
  })

  it('gross approved == applied existing + committed new scope + unapplied, per cost code and in the rollups', () => {
    expect(approvedSupplierVariationsByCostCode([SV1, SV2])).toEqual({ X: 16_000 })
    expect(p.rc.adjustments.byCostCode).toEqual({ X: 12_000 })
    expect(p.rc.adjustments.committedNewScopeByCostCode).toEqual({ X: 4_000 })
    expect(unappliedSupplierVariationsByCostCode([SV1, SV2], [PO])).toEqual({})
    expect(p.rollups.approvedSupplierVariations).toBe(p.rollups.appliedSupplierVariations + p.rollups.committedNewScopeVariations + p.rollups.unappliedSupplierVariations)
    expect(committedNewScopeTotal([SV1, SV2], [PO])).toBe(4_000)
  })

  it('WITHOUT the scope commit the same new scope is exposure only (the M3-B1 reading): remaining 112,000, unapplied 4,000, FFC 122,000 — legacy figures are not moved by deployment', () => {
    const sv2Unscoped = { ...SV2, scopeCommittedAt: undefined, scopeCommittedBy: undefined }
    delete sv2Unscoped.scopeCommittedAt; delete sv2Unscoped.scopeCommittedBy
    const q = position({ variations: [SV1, sv2Unscoped] })
    expect(q.remaining).toBe(112_000)
    expect(q.unapplied).toBe(4_000)
    expect(q.ffc).toBe(122_000)
    expect(q.rc.byVariationLine).toEqual({})
    expect(variationIncorporation(sv2Unscoped, [PO]).state).toBe(INCORPORATION_STATE.NOT_INCORPORATED)
    expect(claimableNewScopeLines([SV1, sv2Unscoped], PO)).toEqual([])
  })
})

describe('case B — an approved claim of 2,000 on the new-scope line', () => {
  const c1 = claim('c1', [poLine0(), varClaimLine(2_000)], [0, 2_000])
  const p = position({ progressClaims: [c1] })
  it('Remaining 114,000 (the variation line nets to 2,000); Actual 2,000; awaiting invoice 2,000; FFC 126,000 — the 2,000 moved, it was not added', () => {
    expect(p.remaining).toBe(114_000)
    expect(p.varLineRemaining).toBe(2_000)
    expect(p.rc.byPoLine.po1).toEqual({ 0: 112_000 })      // the PO line is untouched
    expect(p.actual).toBe(2_000)
    expect(p.awaiting).toBe(2_000)
    expect(p.ffc).toBe(126_000)
  })
  it('the recognition is keyed by the VARIATION line, never PO line 0', () => {
    expect(recognisedClaimsByVariationLine([c1])).toEqual({ sv2: { 0: 2_000 } })
    expect(recognisedClaimsByPoLine([c1])).toEqual({ po1: { 0: 0 } })
    expect(previouslyApprovedByVariationLine([c1])).toEqual({ sv2: { 0: 2_000 } })
    expect(previouslyApprovedByPoLine([c1], 'po1')).toEqual({ 0: 0 })
    expect(actualClaimsByCostCode([c1])).toEqual({ X: 2_000 })
    expect(claimedPoLines([c1], 'po1')).toEqual({})   // the variation line occupies no PO line
  })
})

describe('case C — the claim-sourced invoice posts: the invoice replaces the claim, nothing twice', () => {
  const c1 = claim('c1', [poLine0(), varClaimLine(2_000)], [0, 2_000])
  const si1 = invoiceFrom(c1, 'si1')
  it('the invoice line keeps the variation identity and a null PO index, and the header count is 1', () => {
    expect(si1.lineItems).toEqual([{
      poLineIndex: null, variationId: 'sv2', variationNumber: 'SV-0002', variationLineIndex: 0,
      costCodeId: 'X', costCodeName: '05-200 — Steel', description: 'New scope', amount: 2_000, taxCode: 'gst', gstAmount: 200,
    }])
    expect(si1.variationLineCount).toBe(1)
    expect(si1.payableTotal).toBe(2_200)
  })
  it('draft / approved invoices change nothing; POSTED: Remaining 114,000, Actual 2,000, awaiting 0, FFC 126,000', () => {
    for (const status of [SI_STATUS.DRAFT, SI_STATUS.APPROVED, SI_STATUS.CANCELLED]) {
      const q = position({ progressClaims: [c1], supplierInvoices: [invoiceFrom(c1, 'si1', status)] })
      expect(q).toMatchObject({ remaining: 114_000, actual: 2_000, awaiting: 2_000, ffc: 126_000 })
    }
    const p = position({ progressClaims: [c1], supplierInvoices: [si1] })
    expect(p).toMatchObject({ remaining: 114_000, actual: 2_000, awaiting: 0, ffc: 126_000 })
    expect(invoicedClaimIds([si1]).has('c1')).toBe(true)
    expect(postedInvoicedByVariationLine([si1])).toEqual({ sv2: { 0: 2_000 } })
    expect(postedInvoicedByPoLine([si1])).toEqual({ po1: {} })
    expect(postedInvoicedByPo([si1])).toEqual({})                          // never counted toward the PO total
    expect(recognisedClaimsByVariationLine([c1], invoicedClaimIds([si1]))).toEqual({})
  })
})

describe('case D — cumulative partial claims on one new-scope line', () => {
  const c1 = claim('c1', [poLine0(), varClaimLine(2_000)], [0, 2_000])
  const si1 = invoiceFrom(c1, 'si1')
  const c2 = claim('c2', [poLine0(), varClaimLine(3_500, 2_000)], [0, 1_500])
  it('second claim 1,500 approved (first invoiced): Remaining 112,500; Actual 3,500; awaiting 1,500 — NOT 3,500; FFC 126,000', () => {
    const p = position({ progressClaims: [c1, c2], supplierInvoices: [si1] })
    expect(p).toMatchObject({ remaining: 112_500, actual: 3_500, awaiting: 1_500, ffc: 126_000 })
    expect(p.varLineRemaining).toBe(500)
    expect(c2.lineItems[1]).toMatchObject({ previouslyApproved: 2_000, claimedThisPeriod: 1_500, approvedThisPeriod: 1_500 })
  })
  it('with the SECOND claim\'s invoice ALSO posted, a third claim of 1,000 over-recognises the line: it floors at 0; Remaining 112,000; Actual 4,500; awaiting 1,000 (the third claim only); FFC 126,500; SHIELD lists the 500', () => {
    const si2 = invoiceFrom(c2, 'si2')   // the second claim's invoice is POSTED here — awaiting therefore excludes the 1,500
    const c3 = claim('c3', [poLine0(), varClaimLine(4_500, 3_500)], [0, 1_000])
    const p = position({ progressClaims: [c1, c2, c3], supplierInvoices: [si1, si2] })
    expect(p).toMatchObject({ remaining: 112_000, actual: 4_500, awaiting: 1_000, ffc: 126_500 })
    expect(p.varLineRemaining).toBe(0)
    const states = Object.fromEntries(SHIELD_SOURCES.map(s => [s, { loading: false, error: false }]))
    const shield = evaluateShield({ sources: { ...p.sources, supplierPayments: [], retentionReleases: [] }, sourceStates: states, currencyCode: 'AUD' })
    const c4 = shield.checks.find(c => c.id === CHECK.COMMITMENT_STATE_CONFLICTS)
    expect(c4.state).toBe(SHIELD_STATE.FINDING)
    const row = c4.evidence.find(r => r.condition === STATE_CONFLICT.CLAIM_ABOVE_REVISED_LINE)
    expect(row).toMatchObject({ recordKind: 'variationLine', variationId: 'sv2', variationLineIndex: 0, amount: 500, recognised: 4_500, revisedLineValue: 4_000, recognisedClaims: 1_000, postedInvoiced: 3_500 })
    expect(c4.values.byCondition[STATE_CONFLICT.INVALID_CLAIM_SOURCE_LINE]).toBe(0)
    // The over-claim is warn-only in the editor: the ceiling is the line's approved amount.
    expect(claimLineCeiling(c3.lineItems[1])).toBe(4_000)
    expect(claimLineCeiling(c3.lineItems[0], 12_000)).toBe(112_000)
    // Check 3 raises no false over-invoicing finding from the variation-line invoices.
    const c3check = shield.checks.find(c => c.id === CHECK.PO_OVER_INVOICING)
    expect(c3check.state).toBe(SHIELD_STATE.NO_ISSUE)
  })
})

describe('case E — two variations on one cost code keep distinct identities', () => {
  const SV4 = sv('sv4', 'SV-0004', [newScopeLine(1_500)], { ...APPLIED, ...SCOPE })
  const row4 = { variationId: 'sv4', variationNumber: 'SV-0004', lineIndex: 0, amount: 1_500, costCodeId: 'X', costCodeName: '05-200 — Steel', description: 'New scope' }
  it('revised 105,500 with no SV-0001; a claim on SV-0004 nets SV-0004 only', () => {
    const c = claim('c1', [poLine0(), varClaimLine(0), varClaimLine(1_000, 0, row4)], [0, 0, 1_000])
    const p = position({ variations: [SV2, SV4], progressClaims: [c] })
    expect(p.revisedCommitment).toBe(105_500)
    expect(p.rc.byVariationLine).toEqual({ sv2: { 0: 4_000 }, sv4: { 0: 500 } })
    expect(p.remaining).toBe(104_500)
    expect(p.actual).toBe(1_000)
    expect(p.ffc).toBe(115_500)
    expect(c.variationLineCount).toBe(2)
    expect(validateClaimDraft({ lineItems: c.lineItems.map(li => ({ ...li, claimedThisPeriod: li.claimedThisPeriod })), poId: 'po1' })).toBeNull()
  })
  it('claimableNewScopeLines lists both, in variation-number order, with identity and ceiling', () => {
    expect(claimableNewScopeLines([SV4, SV1, SV2], PO)).toEqual([SV2_ROW, row4])
    expect(claimableNewScopeLines([SV2], { ...PO, status: PO_STATUS.CANCELLED })).toEqual([])
    expect(claimableNewScopeLines([SV2], null)).toEqual([])
  })
})

describe('case F — original PO lines already partially claimed before the new scope is committed', () => {
  const base = claim('c0', [poLine0(30_000)], [30_000])
  it('remaining 82,000 + 4,000 = 86,000; Actual 30,000; FFC 126,000 — the existing claim is untouched', () => {
    const p = position({ progressClaims: [base] })
    expect(p.rc.byPoLine.po1).toEqual({ 0: 82_000 })
    expect(p).toMatchObject({ remaining: 86_000, actual: 30_000, ffc: 126_000, awaiting: 30_000 })
  })
  it('the commit preview warns about a POTENTIAL overlap when the PO line is already recognised above its revised value — a human decision, nothing reassigned', () => {
    const over = claim('c0', [poLine0(114_000)], [114_000])   // base line over-claimed (new-scope work claimed on it before B2)
    const sv2Unscoped = { ...SV2 }; delete sv2Unscoped.scopeCommittedAt; delete sv2Unscoped.scopeCommittedBy
    const pv = commitmentEffectPreview({ variation: sv2Unscoped, purchaseOrders: [PO], progressClaims: [over], supplierInvoices: [], variations: [SV1, sv2Unscoped], forecastLines: [] })
    expect(pv).toMatchObject({ willApply: true, willCommitScope: true, overRecognitionWarning: true })
    expect(pv.overRecognisedPoLines).toEqual([{ poLineIndex: 0, costCodeName: '05-200 — Steel', revised: 112_000, recognised: 114_000, excess: 2_000 }])
    expect(pv.totals.newScopeCommittable).toBe(4_000)
    const clean = commitmentEffectPreview({ variation: sv2Unscoped, purchaseOrders: [PO], progressClaims: [base], supplierInvoices: [], variations: [SV1, sv2Unscoped], forecastLines: [] })
    expect(clean.overRecognitionWarning).toBe(false)
  })
})

describe('case G — a NEGATIVE new-scope line is never matured or claimable', () => {
  const SV3 = sv('sv3', 'SV-0003', [newScopeLine(-3_000)], { ...APPLIED, ...SCOPE })
  it('stays signed exposure (−3,000), enters no commitment line, is an exception for review, and FFC is unchanged', () => {
    const p = position({ variations: [SV1, SV3] })
    expect(p.remaining).toBe(112_000)
    expect(p.unapplied).toBe(-3_000)
    expect(p.ffc).toBe(122_000)
    expect(p.rc.byVariationLine).toEqual({})
    const inc = variationIncorporation(SV3, [PO])
    expect(inc).toMatchObject({ state: INCORPORATION_STATE.NEGATIVE_NEW_SCOPE, matured: 0, outstanding: -3_000, negativeNewScope: -3_000, committedNewScope: 0 })
    expect(p.rc.adjustments.exceptions.map(e => e.kind)).toEqual(['negative_new_scope'])
    expect(claimableNewScopeLines([SV3], PO)).toEqual([])
    // A scope-only commit on a variation with only a negative new-scope line has nothing to commit.
    const b1 = { ...SV3 }; delete b1.scopeCommittedAt; delete b1.scopeCommittedBy
    expect(commitmentApplyEligibility(b1, [PO]).blocker).toBe(COMMITMENT_APPLY_BLOCKER.ALREADY_APPLIED)
    const pv = commitmentEffectPreview({ variation: b1, purchaseOrders: [PO], variations: [b1], forecastLines: [] })
    expect(pv.newScopeNegative.map(l => l.amount)).toEqual([-3_000])
    expect(pv.willCommitScope).toBe(false)
    expect(pv.totals.newScopeNegative).toBe(-3_000)
  })
})

describe('case H — duplicates and forged sources: what the app refuses and what only SHIELD can list', () => {
  it('a duplicated source line in one claim is refused by validateClaimDraft; a claim-sourced invoice never carries a duplicated identity either', () => {
    const lines = [poLine0(), varClaimLine(1_000), varClaimLine(1_000)]
    expect(validateClaimDraft({ lineItems: lines, poId: 'po1' })).toMatch(/SV-0002 line 1 appears more than once/)
  })
  it('variationSourceError (the create transaction) refuses every broken source with the line named', () => {
    const lines = [poLine0(), varClaimLine(2_000)]
    const ok = variationSourceError(lines, { po: PO, variations: [SV2], variationIds: ['sv2'] })
    expect(ok).toBeNull()
    const cases = [
      [{ variations: [null], variationIds: ['sv2'] }, /Variation not found/],
      [{ variations: [{ ...SV2, variationType: 'client' }] }, /not a supplier variation/],
      [{ variations: [{ ...SV2, status: 'submitted' }] }, /not approved/],
      [{ variations: [{ ...SV2, poId: 'po9' }] }, /does not name this purchase order/],
      [{ variations: [{ ...SV2, commitmentAppliedAt: null, commitmentAppliedBy: null }] }, /not been applied/],
      [{ variations: [{ ...SV2, scopeCommittedAt: null, scopeCommittedBy: null }] }, /new scope has not been committed/],
      [{ variations: [{ ...SV2, lineItems: [] }] }, /line index does not exist/],
      [{ variations: [{ ...SV2, lineItems: [svLine(4_000)] }] }, /not valid new scope/],
      [{ variations: [{ ...SV2, lineItems: [newScopeLine(-4_000)] }] }, /not positive/],
      [{ variations: [{ ...SV2, lineItems: [newScopeLine(4_000, { costCodeId: 'Y' })] }] }, /Cost code differs/],
      [{ variations: [{ ...SV2, lineItems: [newScopeLine(4_500)] }] }, /ceiling differs/],
      [{ po: { ...PO, status: PO_STATUS.CANCELLED }, variations: [SV2] }, /not valid new scope/],
    ]
    for (const [over, re] of cases) {
      const err = variationSourceError(lines, { po: PO, variations: [SV2], variationIds: ['sv2'], ...over })
      expect(err, String(re)).toMatch(/^Line 2 \(SV-0002 line 1\): /)
      expect(err).toMatch(re)
    }
  })
  it('claimVariationLineIssue reports the exact code; a PO-origin line never has a variation issue', () => {
    expect(claimVariationLineIssue(poLine0(), { variation: null, po: PO })).toBeNull()
    expect(claimVariationLineIssue(varClaimLine(1), { variation: null, po: PO })).toBe(CLAIM_VARIATION_LINE_ISSUE.VARIATION_MISSING)
    expect(claimVariationLineIssue(varClaimLine(1), { variation: SV2, po: PO, classify: classifyCommitmentLines })).toBeNull()
    expect(claimVariationLineIssue(varClaimLine(1), { variation: SV2, po: { ...PO, status: PO_STATUS.CANCELLED }, classify: classifyCommitmentLines })).toBe(CLAIM_VARIATION_LINE_ISSUE.NOT_NEW_SCOPE)
  })
  it('SHIELD check 4 condition H lists a claim line whose variation no longer backs it, and a claim with malformed / duplicated identities — the certified amount stays in Actual, nets no commitment', () => {
    const c1 = claim('c1', [poLine0(), varClaimLine(2_000)], [0, 2_000])
    const sv2Unscoped = { ...SV2 }; delete sv2Unscoped.scopeCommittedAt; delete sv2Unscoped.scopeCommittedBy
    const corrupted = claim('c2', [poLine0(500), { ...varClaimLine(700), poLineIndex: 0, variationId: undefined }], [500, 700])
    delete corrupted.lineItems[1].variationId
    const p = position({ variations: [SV1, sv2Unscoped], progressClaims: [c1, corrupted] })
    // c1's 2,000 is in Actual but nets nothing (no committed line); the corrupted claim's second line is malformed.
    expect(p.actual).toBe(3_200)
    expect(p.rc.byVariationLine).toEqual({})
    expect(p.rc.byPoLine.po1).toEqual({ 0: 112_000 - 500 - 700 })   // the corrupted line DOES net PO line 0 — exactly the corruption SHIELD must surface
    const states = Object.fromEntries(SHIELD_SOURCES.map(s => [s, { loading: false, error: false }]))
    const c4 = evaluateShield({ sources: { ...p.sources, supplierPayments: [], retentionReleases: [] }, sourceStates: states, currencyCode: 'AUD' })
      .checks.find(c => c.id === CHECK.COMMITMENT_STATE_CONFLICTS)
    const rows = c4.evidence.filter(r => r.condition === STATE_CONFLICT.INVALID_CLAIM_SOURCE_LINE)
    expect(rows.map(r => r.issue).sort()).toEqual(['identity_malformed', CLAIM_VARIATION_LINE_ISSUE.NOT_SCOPE_COMMITTED].sort())
    expect(rows.find(r => r.recordId === 'c1')).toMatchObject({ amount: 2_000, variationId: 'sv2' })
    expect(rows.find(r => r.recordId === 'c2').recordNumber).toMatch(/PO line 1 appears more than once/)
    expect(c4.values.byCondition[STATE_CONFLICT.INVALID_CLAIM_SOURCE_LINE]).toBe(2)
  })
  it('SHIELD check 3 compares a variation-line invoice with ITS ceiling and never with the PO subtotal', () => {
    const c1 = claim('c1', [poLine0(), varClaimLine(4_500)], [0, 4_500])   // over-certified above the 4,000 ceiling
    const si1 = invoiceFrom(c1, 'si1')
    const states = Object.fromEntries(SHIELD_SOURCES.map(s => [s, { loading: false, error: false }]))
    const p = position({ progressClaims: [c1], supplierInvoices: [si1] })
    const c3 = evaluateShield({ sources: { ...p.sources, supplierPayments: [], retentionReleases: [] }, sourceStates: states, currencyCode: 'AUD' })
      .checks.find(c => c.id === CHECK.PO_OVER_INVOICING)
    expect(c3.state).toBe(SHIELD_STATE.FINDING)
    expect(c3.evidence).toHaveLength(1)
    expect(c3.evidence[0]).toMatchObject({ level: 'variationLine', variationId: 'sv2', poAmount: 4_000, invoiced: 4_500, excess: 500, poNumber: 'PO-0001' })
    expect(c3.values.variationLineRowCount).toBe(1)
    expect(c3.values.poRowCount).toBe(0)
  })
})

describe('case I — cancelled or missing PO: new scope is INVALID, never valid new scope (the B1 ordering fix)', () => {
  it('classifyCommitmentLines marks a new-scope line on a cancelled or missing PO INVALID with the PO issue; nothing is committed or claimable', () => {
    expect(classifyCommitmentLines(SV2, { ...PO, status: PO_STATUS.CANCELLED })[0]).toMatchObject({ kind: COMMITMENT_LINE_KIND.INVALID, issue: COMMITMENT_LINE_ISSUE.PO_NOT_COMMITTED })
    expect(classifyCommitmentLines(SV2, null)[0]).toMatchObject({ kind: COMMITMENT_LINE_KIND.INVALID, issue: COMMITMENT_LINE_ISSUE.PO_MISSING })
    const p = position({ purchaseOrders: [{ ...PO, status: PO_STATUS.CANCELLED }] })
    expect(p.remaining).toBe(0)
    expect(p.rc.byVariationLine).toEqual({})
    expect(p.unapplied).toBe(16_000)
    expect(p.rc.adjustments.exceptions.map(e => e.issue)).toEqual(['po_not_committed', 'po_not_committed'])
    expect(variationIncorporation(SV2, [{ ...PO, status: PO_STATUS.CANCELLED }]).state).toBe(INCORPORATION_STATE.EXCEPTION)
  })
  it('the closed-PO residual follows the committed new-scope line with its PO', () => {
    const closed = { ...PO, status: PO_STATUS.CLOSED }
    const r = closedResidualCommitment({ purchaseOrders: [closed], progressClaims: [], supplierInvoices: [], variations: [SV1, SV2] })
    expect(r.byCostCode).toEqual({ X: 116_000 })
    expect(closedResidualCommitment({ purchaseOrders: [PO], progressClaims: [], supplierInvoices: [], variations: [SV1, SV2] }).byCostCode).toEqual({})
  })
})

// ── Builders, identity and the claim transactions ────────────────────────────

describe('builders never invent PO line 0 and carry the variation identity', () => {
  it('buildVariationClaimLine produces the stored variation-origin shape', () => {
    expect(varClaimLine(2_000)).toEqual({
      poLineIndex: null, variationId: 'sv2', variationNumber: 'SV-0002', variationLineIndex: 0, variationLineTotal: 4_000, poLineTotal: null,
      costCodeId: 'X', costCodeName: '05-200 — Steel', description: 'New scope',
      previouslyApproved: 0, claimedToDate: 2_000, claimedThisPeriod: 2_000, approvedThisPeriod: null,
    })
    expect(sourceLineKind(varClaimLine(1))).toBe(SOURCE_LINE_KIND.VARIATION_LINE)
    expect(sourceLineKind(poLine0())).toBe(SOURCE_LINE_KIND.PO_LINE)
  })
  it('a draft edit over a stored variation line (the ADR-37 rebuild) keeps the identity and re-authors only the amount', () => {
    const stored = { ...varClaimLine(2_000), approvedThisPeriod: 99 }
    expect(buildClaimLine(stored, { claimedToDate: '3500' })).toEqual({ ...varClaimLine(3_500), claimedThisPeriod: 3_500 })
    const live = claim('c', [poLine0(), varClaimLine(2_000)], [0, 2_000], { status: CLAIM_STATUS.DRAFT, revision: 1 })
    const upd = claimDraftUpdate(live, { periodEnding: '', claimRef: '', notes: '', retention: 0, claimedToDate: ['100', '3000'] }, 'u', 'NOW')
    expect(upd.lineItems[1]).toMatchObject({ poLineIndex: null, variationId: 'sv2', variationLineIndex: 0, claimedToDate: 3_000, claimedThisPeriod: 3_000 })
    expect(upd.lineItems[0]).toMatchObject({ poLineIndex: 0, claimedToDate: 100 })
  })
  it('approve keeps the identity, and refuses a stored line set whose identities are malformed or duplicated', () => {
    const live = claim('c', [poLine0(), varClaimLine(2_000)], [0, 2_000], { status: CLAIM_STATUS.SUBMITTED, revision: 2 })
    const upd = claimTransitionUpdate(live, CLAIM_STATUS.APPROVED, { approvedAmounts: [0, 2_000], assessmentNotes: '' }, 'u', 'NOW')
    expect(upd.lineItems[1]).toMatchObject({ variationId: 'sv2', variationLineIndex: 0, approvedThisPeriod: 2_000 })
    const broken = { ...live, lineItems: [live.lineItems[0], { ...live.lineItems[1], poLineIndex: 0, variationId: undefined }] }
    delete broken.lineItems[1].variationId
    expect(() => claimTransitionUpdate(broken, CLAIM_STATUS.APPROVED, { approvedAmounts: [0, 2_000], assessmentNotes: '' }, 'u', 'NOW')).toThrow(/appears more than once.*Withdraw this claim/)
  })
  it('buildInvoiceLine keeps a variation identity, and a malformed PO index becomes null rather than 0', () => {
    expect(buildInvoiceLine(varClaimLine(2_000), { amount: 2_000, taxCode: 'gst' })).toMatchObject({ poLineIndex: null, variationId: 'sv2', variationLineIndex: 0 })
    expect(buildInvoiceLine({ poLineIndex: null, costCodeId: 'X' }, { amount: 1, taxCode: 'gst' }).poLineIndex).toBeNull()
    expect(directInvoicedPoLines([{ poId: 'po1', source: SI_SOURCE.DIRECT_PO, status: SI_STATUS.DRAFT, lineItems: [{ poLineIndex: null, variationId: 'sv2', variationLineIndex: 0, amount: 5 }] }], 'po1')).toEqual({})
  })
  it('variationOriginClaimLines lists every variation line with its claim status, rejected claims excluded', () => {
    const c1 = claim('c1', [poLine0(), varClaimLine(2_000)], [0, 2_000])
    const rej = claim('c2', [poLine0(), varClaimLine(1)], [0, 1], { status: CLAIM_STATUS.REJECTED })
    expect(variationOriginClaimLines([c1, rej]).map(r => [r.claimId, r.lineIndex])).toEqual([['c1', 1]])
  })
  it('SCOPE_COMMITMENT_KEYS and isScopeCommitted require both halves', () => {
    expect(SCOPE_COMMITMENT_KEYS).toEqual(['scopeCommittedAt', 'scopeCommittedBy'])
    expect(isScopeCommitted(SV2)).toBe(true)
    expect(isScopeCommitted({ scopeCommittedAt: T })).toBe(false)
    expect(isScopeCommitted({ scopeCommittedBy: 'u' })).toBe(false)
  })
  it('remainingCommittedByVariationLine / ByCostCode net invoices and claims and floor at zero', () => {
    const lines = { sv2: { 0: { amount: 4_000, costCodeId: 'X' } }, sv4: { 0: { amount: 1_500, costCodeId: 'Y' } } }
    expect(remainingCommittedByVariationLine(lines, { sv2: { 0: 3_000 } }, { sv2: { 0: 2_000 } })).toEqual({ sv2: { 0: 0 }, sv4: { 0: 1_500 } })
    expect(remainingCommittedNewScopeByCostCode(lines, { sv2: { 0: 1_000 } }, {})).toEqual({ X: 3_000, Y: 1_500 })
  })
})

// ── Downstream consumers carry the same figures ──────────────────────────────

describe('Margin, Dashboard snapshot, Cash Flow and PULSE carry the committed new scope once', () => {
  const c1 = claim('c1', [poLine0(), varClaimLine(2_000)], [0, 2_000])
  const p = position({ progressClaims: [c1] })
  const full = { ...p.sources, supplierPayments: [], retentionReleases: [], baseline: { originalContractValue: 200_000, originalApprovedBudget: 150_000 } }

  it('margin: FFC 126,000, committed new scope 4,000 reported apart from applied 12,000, unapplied 0; gross profit 74,000', () => {
    const t = projectForecastTotals(p.sources)
    const m = computeMargin({ baseline: full.baseline, variations: [SV1, SV2], forecastFinalCost: t.forecastFinalCost, purchaseOrders: [PO] })
    expect(m).toMatchObject({ forecastFinalCost: 126_000, appliedSupplierVariations: 12_000, committedNewScopeVariations: 4_000, unappliedSupplierVariations: 0, approvedSupplierVariations: 16_000, forecastGrossProfit: 74_000 })
  })
  it('snapshot: Remaining Committed 114,000 and FFC 126,000; the committed-new-scope figure depends on variations AND purchase orders', () => {
    const settled = Object.fromEntries(SNAPSHOT_SOURCES.map(s => [s, { loading: false, error: false }]))
    const snap = projectSnapshot({ sources: full, sourceStates: settled, currencyCode: 'AUD' })
    expect(snap.remainingCommitted.value).toBe(114_000)
    expect(snap.forecastFinalCost.value).toBe(126_000)
    expect(FIGURE_DEPENDENCIES.committedNewScopeVariations).toEqual(['variations', 'purchaseOrders'])
  })
  it('cash flow: the cost denominator is Remaining Committed + claims awaiting invoice + CTC = 126,000 — the claim is in one basis only', () => {
    const t = projectForecastTotals(p.sources)
    const cov = costCoverage({ remainingCommittedTotal: t.remainingCommitted, uninvoicedClaimTotal: t.approvedClaimsAwaitingInvoice, uncommittedCtcTotal: t.uncommittedCostToComplete, lines: [] })
    expect(t.remainingCommitted + t.approvedClaimsAwaitingInvoice + t.uncommittedCostToComplete).toBe(126_000)
    expect(cov.pct).toBe(0)
  })
  it('PULSE indicator 1 reads the FFC including committed new scope; with a 120,000 budget it is a finding', () => {
    const states = Object.fromEntries(PULSE_SOURCES.map(s => [s, { loading: false, error: false }]))
    const pulse = evaluatePulse({ sources: { ...full, activities: [] }, sourceStates: states, currencyCode: 'AUD' })
    const over = pulse.indicators.find(i => i.id === INDICATOR.FORECAST_OVER_BUDGET)
    expect(over.values.forecastFinalCost).toBe(126_000)
    const tight = position({ progressClaims: [c1], budget: 120_000 })
    const pulse2 = evaluatePulse({ sources: { ...tight.sources, supplierPayments: [], retentionReleases: [], baseline: full.baseline, activities: [] }, sourceStates: states, currencyCode: 'AUD' })
    expect(pulse2.indicators.find(i => i.id === INDICATOR.FORECAST_OVER_BUDGET).state).toBe('finding')
  })
})

// ── Correction A — the claims-awaiting-invoice sequence, step by step ─────────
//
// `approvedClaimsAwaitingInvoice` is the approved claim value NOT yet superseded
// by a POSTED claim-sourced invoice (the ADR-55 hand-over set). It drops only
// when THAT claim's invoice posts — never when a later claim is approved.

describe('Correction A — awaiting invoice follows each claim’s OWN posted invoice (sequential A–F)', () => {
  const c1 = claim('c1', [poLine0(), varClaimLine(2_000)], [0, 2_000])
  const si1 = invoiceFrom(c1, 'si1')
  const c2 = claim('c2', [poLine0(), varClaimLine(3_500, 2_000)], [0, 1_500])
  const si2 = invoiceFrom(c2, 'si2')
  const c3 = claim('c3', [poLine0(), varClaimLine(4_500, 3_500)], [0, 1_000])
  const si3 = invoiceFrom(c3, 'si3')
  const at = (progressClaims, supplierInvoices) => {
    const p = position({ progressClaims, supplierInvoices })
    return { remaining: p.remaining, actual: p.actual, awaiting: p.awaiting, ffc: p.ffc }
  }

  it('A — first claim 2,000 approved: awaiting 2,000 · Actual 2,000 · Remaining 114,000 · FFC 126,000', () => {
    expect(at([c1], [])).toEqual({ remaining: 114_000, actual: 2_000, awaiting: 2_000, ffc: 126_000 })
  })
  it('B — first claim’s invoice posted: awaiting 0 · Actual 2,000 (the invoice replaces the claim) · Remaining 114,000 · FFC 126,000', () => {
    expect(at([c1], [si1])).toEqual({ remaining: 114_000, actual: 2_000, awaiting: 0, ffc: 126_000 })
  })
  it('C — second claim 1,500 approved: awaiting 1,500 · Actual 3,500 · Remaining 112,500 · FFC 126,000', () => {
    expect(at([c1, c2], [si1])).toEqual({ remaining: 112_500, actual: 3_500, awaiting: 1_500, ffc: 126_000 })
  })
  it('D — third claim 1,000 approved, second claim STILL uninvoiced: awaiting 2,500 · Actual 4,500 · the line floors at 0 so Remaining 112,000 · FFC 126,500', () => {
    expect(at([c1, c2, c3], [si1])).toEqual({ remaining: 112_000, actual: 4_500, awaiting: 2_500, ffc: 126_500 })
  })
  it('E — second claim’s invoice posted: awaiting 1,000 · Actual 4,500 · Remaining 112,000 · FFC 126,500', () => {
    expect(at([c1, c2, c3], [si1, si2])).toEqual({ remaining: 112_000, actual: 4_500, awaiting: 1_000, ffc: 126_500 })
  })
  it('F — third claim’s invoice posted: awaiting 0 · Actual 4,500 · Remaining 112,000 · FFC 126,500', () => {
    expect(at([c1, c2, c3], [si1, si2, si3])).toEqual({ remaining: 112_000, actual: 4_500, awaiting: 0, ffc: 126_500 })
  })
  it('the hand-over is per claim: a DRAFT, APPROVED or CANCELLED invoice supersedes nothing; posting si2 before si1 drops only c2', () => {
    for (const status of [SI_STATUS.DRAFT, SI_STATUS.APPROVED, SI_STATUS.CANCELLED]) {
      expect(at([c1, c2, c3], [invoiceFrom(c1, 'si1', status)]).awaiting).toBe(4_500)
    }
    expect(at([c1, c2, c3], [si2]).awaiting).toBe(3_000)
    expect(recognisedClaimsByVariationLine([c1, c2, c3], invoicedClaimIds([si2]))).toEqual({ sv2: { 0: 3_000 } })
  })
})

// ── Correction B — Cash Flow reconciliation, source by source ─────────────────
//
// Six figures, each from its own selector, never derived from one another:
//   Remaining Committed            forecast rollups (lib/commitment.js)          ex-GST
//   Approved claims awaiting inv.  forecast rollups → approvedClaimsAwaitingInvoice ex-GST
//   Posted but UNPAID AP           payablesSummary(...).remaining                GROSS payable (inc. GST, net of
//                                                                              retention, paid and credits)
//   Payments made                  totalActualCashOut(cashOutRows(payments))     GROSS cash
//   Uncommitted CTC                forecast rollups                              ex-GST
//   Forecast Final Cost            forecast rollups                              ex-GST
//
// The cash model's forward basis (D_cost = Remaining + awaiting + CTC) EXCLUDES
// posted invoices: once posted, a claim's value is an AP balance timed by its
// due month (gross), not a forecast cost basis. The reconciliation identity is
//   FFC = Remaining + awaiting + CTC + posted invoiced ex-GST (net of posted valid credits)
// — a posted invoice is in exactly one of {unpaid AP, paid}, and a claim is in
// exactly one of {awaiting, its posted invoice}.

describe('Correction B — Cash Flow reconciliation (posted ≠ paid; nothing in two baskets)', () => {
  const NOW = '2026-10'
  const c1 = claim('c1', [poLine0(), varClaimLine(2_000)], [0, 2_000])
  const si1 = invoiceFrom(c1, 'si1')                       // due 2026-11-15 → timed in 2026-11, gross 2,200
  const c2 = claim('c2', [poLine0(), varClaimLine(3_500, 2_000)], [0, 1_500])
  const c3 = claim('c3', [poLine0(), varClaimLine(4_500, 3_500)], [0, 1_000])
  const payment = (allocatedAmount, over = {}) => ({
    id: 'p1', paymentNumber: 'SP-0001', status: 'posted', docType: 'payment', supplierId: 'sup1', supplierName: 'Steel Co',
    paymentDate: '2026-11-10', amount: allocatedAmount, allocatedTotal: allocatedAmount, unallocatedAmount: 0, currency: 'AUD',
    allocations: [{ supplierInvoiceId: 'si1', invoiceNumber: 'SI-si1', supplierInvoiceNumber: 'INV-si1', allocatedAmount }], ...over,
  })
  const creditNote = (amount, over = {}) => ({
    id: 'cn1', creditNumber: 'SCN-0001', status: 'posted', docType: 'credit_note', supplierInvoiceId: 'si1', invoiceNumber: 'SI-si1',
    supplierInvoiceNumber: 'INV-si1', supplierId: 'sup1', supplierName: 'Steel Co', currency: 'AUD', creditDate: '2026-11-20', reason: 'Over-certified',
    lineItems: [{ costCodeId: 'X', costCodeName: '05-200 — Steel', description: 'Credit', amount, taxCode: 'gst', gstAmount: amount / 10 }],
    subtotal: amount, gstTotal: amount / 10, grossTotal: amount * 1.1, ...over,
  })

  function reconcile({ progressClaims = [], supplierInvoices = [], supplierPayments = [], supplierCreditNotes = [] }) {
    const p = position({ progressClaims, supplierInvoices, supplierCreditNotes })
    const t = projectForecastTotals(p.sources)
    const ap = payablesSummary(supplierInvoices, supplierPayments, supplierCreditNotes, {})
    const apClass = classifyInvoiceBalances(supplierInvoiceReconciliationRows(supplierInvoices, supplierPayments, supplierCreditNotes, {}), NOW)
    const postedExGst = (invoicedByCostCode(supplierInvoices).X || 0) - (creditedByCostCode(supplierCreditNotes, supplierInvoices).X || 0)
    const dCost = costCoverage({ remainingCommittedTotal: t.remainingCommitted, uninvoicedClaimTotal: t.approvedClaimsAwaitingInvoice, uncommittedCtcTotal: t.uncommittedCostToComplete, lines: [] })
    return {
      remaining: t.remainingCommitted, awaiting: t.approvedClaimsAwaitingInvoice, ctc: t.uncommittedCostToComplete, actual: t.actual, ffc: t.forecastFinalCost,
      unpaidApGross: ap.remaining, unpaidApOverReconciled: ap.overReconciled, apTimedByMonth: apClass.byMonth, apPastDue: apClass.pastDue,
      paidGross: totalActualCashOut(cashOutRows(supplierPayments, { projectId: 'p' })),
      postedExGst,
      // The forward cash basis Cash Flow times (ex-GST) — must equal FFC − posted invoiced ex-GST.
      forwardCostBasis: t.remainingCommitted + t.approvedClaimsAwaitingInvoice + t.uncommittedCostToComplete,
      coverageDenominatorPct: dCost.pct,
    }
  }
  const expectIdentity = (r) => {
    expect(r.forwardCostBasis + r.postedExGst).toBe(r.ffc)                  // FFC = D_cost + posted invoiced ex-GST
    expect(r.actual).toBe(r.awaiting + r.postedExGst)                        // Actual = claims awaiting + posted invoices (net of credits)
  }

  it('before claims: Remaining 116,000 · awaiting 0 · unpaid AP 0 · CTC 10,000 · FFC 126,000', () => {
    const r = reconcile({})
    expect(r).toMatchObject({ remaining: 116_000, awaiting: 0, unpaidApGross: 0, ctc: 10_000, ffc: 126_000, paidGross: 0, postedExGst: 0, apTimedByMonth: {} })
    expectIdentity(r)
  })
  it('after claim 2,000 approved: Remaining 114,000 · awaiting 2,000 · unpaid AP 0 · CTC 10,000 · FFC 126,000', () => {
    const r = reconcile({ progressClaims: [c1] })
    expect(r).toMatchObject({ remaining: 114_000, awaiting: 2_000, unpaidApGross: 0, ctc: 10_000, ffc: 126_000, paidGross: 0, apTimedByMonth: {} })
    expectIdentity(r)
  })
  it('after the first invoice POSTED (not paid): Remaining 114,000 · awaiting 0 · unpaid AP 2,000 ex-GST = 2,200 gross, timed in its due month · CTC 10,000 · FFC 126,000', () => {
    const r = reconcile({ progressClaims: [c1], supplierInvoices: [si1] })
    expect(r).toMatchObject({ remaining: 114_000, awaiting: 0, unpaidApGross: 2_200, postedExGst: 2_000, ctc: 10_000, ffc: 126_000, paidGross: 0, apTimedByMonth: { '2026-11': 2_200 }, apPastDue: 0 })
    expectIdentity(r)
    // Posting moved the 2,000 from the awaiting basis to the AP balance — the forward cash basis fell by exactly it; FFC did not move.
    expect(r.forwardCostBasis).toBe(124_000)
  })
  it('after the second claim 1,500: Remaining 112,500 · awaiting 1,500 · unpaid AP still 2,200 gross · CTC 10,000 · FFC 126,000', () => {
    const r = reconcile({ progressClaims: [c1, c2], supplierInvoices: [si1] })
    expect(r).toMatchObject({ remaining: 112_500, awaiting: 1_500, unpaidApGross: 2_200, postedExGst: 2_000, ctc: 10_000, ffc: 126_000 })
    expectIdentity(r)
  })
  it('after the third claim 1,000 (second still uninvoiced): Remaining 112,000 (line floored) · awaiting 2,500 · unpaid AP 2,200 gross · CTC 10,000 · FFC 126,500', () => {
    const r = reconcile({ progressClaims: [c1, c2, c3], supplierInvoices: [si1] })
    expect(r).toMatchObject({ remaining: 112_000, awaiting: 2_500, unpaidApGross: 2_200, postedExGst: 2_000, ctc: 10_000, ffc: 126_500, actual: 4_500 })
    expectIdentity(r)
    expect(r.forwardCostBasis).toBe(124_500)   // the 500 overrun is in Actual (awaiting), not in Remaining
  })
  it('paying the first invoice in full (2,200 gross): unpaid AP 0 · cash out 2,200 · Actual, Remaining, awaiting and FFC unchanged', () => {
    const r = reconcile({ progressClaims: [c1, c2, c3], supplierInvoices: [si1], supplierPayments: [payment(2_200)] })
    expect(r).toMatchObject({ unpaidApGross: 0, paidGross: 2_200, remaining: 112_000, awaiting: 2_500, actual: 4_500, ffc: 126_500, apTimedByMonth: {} })
    expectIdentity(r)
    // A partial payment leaves the gross remainder timed by due month; a draft payment moves nothing.
    expect(reconcile({ progressClaims: [c1], supplierInvoices: [si1], supplierPayments: [payment(1_100)] })).toMatchObject({ unpaidApGross: 1_100, paidGross: 1_100, apTimedByMonth: { '2026-11': 1_100 } })
    expect(reconcile({ progressClaims: [c1], supplierInvoices: [si1], supplierPayments: [payment(2_200, { status: 'draft' })] })).toMatchObject({ unpaidApGross: 2_200, paidGross: 0 })
  })
  it('a posted VALID credit note of 100 ex-GST against the posted invoice reduces Actual, Invoiced and the unpaid AP (110 gross) — never Remaining Committed; the identity still holds', () => {
    const cn = creditNote(100)
    expect(creditTargetException(cn, new Map([[si1.id, si1]]))).toBeNull()
    const r = reconcile({ progressClaims: [c1], supplierInvoices: [si1], supplierCreditNotes: [cn] })
    expect(r).toMatchObject({ remaining: 114_000, awaiting: 0, actual: 1_900, postedExGst: 1_900, unpaidApGross: 2_090, ffc: 125_900 })
    expectIdentity(r)
    // After full payment the credit leaves a recoverable (negative) position, reported separately — never netted into payable.
    const paidThenCredited = reconcile({ progressClaims: [c1], supplierInvoices: [si1], supplierPayments: [payment(2_200)], supplierCreditNotes: [cn] })
    expect(paidThenCredited).toMatchObject({ unpaidApGross: 0, unpaidApOverReconciled: -110, actual: 1_900, ffc: 125_900 })
    // An INVALID credit (a cost code not on the target) counts zero on both sides and leaves every figure as it was.
    const bad = creditNote(100, { lineItems: [{ costCodeId: 'Z', costCodeName: 'Z', description: 'x', amount: 100, taxCode: 'gst', gstAmount: 10 }] })
    expect(creditTargetException(bad, new Map([[si1.id, si1]]))).toMatch(/not on SI-si1/)
    expect(reconcile({ progressClaims: [c1], supplierInvoices: [si1], supplierCreditNotes: [bad] })).toMatchObject({ actual: 2_000, unpaidApGross: 2_200, ffc: 126_000 })
    // A negative new-scope variation never becomes a credit note or an Actual offset (case G) — signed exposure only.
    const SV3 = sv('sv3', 'SV-0003', [newScopeLine(-3_000)], { ...APPLIED, ...SCOPE })
    const neg = position({ variations: [SV1, SV2, SV3], progressClaims: [c1], supplierInvoices: [si1] })
    expect(neg).toMatchObject({ actual: 2_000, remaining: 114_000, unapplied: -3_000, ffc: 126_000 })
  })
  it('a posted invoice balance is never ALSO inside Remaining Committed, and a claim is never beside its posted invoice', () => {
    const before = reconcile({ progressClaims: [c1] })
    const after = reconcile({ progressClaims: [c1], supplierInvoices: [si1] })
    expect(after.remaining).toBe(before.remaining)                    // posting nets the variation line exactly as the claim did
    expect(after.awaiting + after.postedExGst).toBe(before.awaiting)  // the 2,000 moved baskets, it was not added
    expect(after.coverageDenominatorPct).toBe(0)                      // no timing lines → 0 % covered of the forward basis
  })
})
