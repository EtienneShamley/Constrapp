import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { buildForecastRows, composeForecastRow } from '../../src/lib/forecast'
import { projectForecastTotals } from '../../src/lib/margin'
import { PO_STATUS } from '../../src/lib/purchaseOrders'
import { CLAIM_STATUS } from '../../src/lib/progressClaims'
import {
  SI_STATUS, SI_SOURCE, SI_TRANSITIONS, canTransition, invoiceTotals, claimReconciliationError,
  claimHasActiveInvoice, invoicedClaimIds,
} from '../../src/lib/supplierInvoices'
import { supplierInvoiceReconciliationRows } from '../../src/lib/supplierPayments'
import { classifyInvoiceBalances, costCoverage, untimedUninvoicedClaims, untimedRemainingCommitted } from '../../src/lib/cashFlow'

// ── ADR-55 — the approved-claim → invoice lifecycle, end to end ───────────────
//
// One PO line of 800 (cost code c), budget 1,000, Uncommitted CTC 150. A claim
// is approved for 300 and then invoiced from the claim. At every step the
// recognition policy is unchanged (Actual recognises the approved claim, the
// posted claim-sourced invoice replaces it), the 300 is counted exactly once in
// Forecast Final Cost, and Cash Flow carries it once as future cash.
//
//   step                          Actual  Rem.Committed  CostToComplete  FFC   cash basis (claim | AP balance)
//   no claim                        0        800            950          950   —     | —
//   claim submitted                 0        800            950          950   —     | —
//   claim approved, no invoice    300        500            650          950   300   | —
//   claim-sourced invoice DRAFT   300        500            650          950   300   | —
//   …APPROVED (not posted)        300        500            650          950   300   | —
//   …CANCELLED before posting     300        500            650          950   300   | —
//   …POSTED                       300        500            650          950   0     | 330 gross due month
//
// A PARTIAL claim-sourced invoice does not exist as a state: creation is
// refused unless the invoice pays exactly the claim's certified GST and total
// (claimReconciliationError — hook and editor), a claim may carry one active
// invoice (claimHasActiveInvoice), and a posted invoice is terminal (no
// cancel). Both guards are client-side; rules freeze a claim-sourced invoice's
// money once written but cannot compare it to the claim (SECURITY.md DC29).

const read = (rel) => readFileSync(fileURLToPath(new URL(`../../src/${rel}`, import.meta.url)), 'utf8')
const NOW = '2026-10'

const PO = { id: 'po', poNumber: 'PO-0001', status: PO_STATUS.SENT, lineItems: [
  { costCodeId: 'c', costCodeName: 'C', description: 'Slab', lineTotal: 800 },
] }
const CLAIM_LINE = { poLineIndex: 0, costCodeId: 'c', poLineTotal: 800, previouslyApproved: 0, claimedToDate: 300, claimedThisPeriod: 300 }
const approvedClaim = (over = {}) => ({
  id: 'cl1', claimNumber: 'PC-0001', status: CLAIM_STATUS.APPROVED, poId: 'po', poNumber: 'PO-0001',
  lineItems: [{ ...CLAIM_LINE, approvedThisPeriod: 300 }],
  retention: 0, approvedSubtotal: 300, approvedGst: 30, approvedTotal: 330, ...over,
})
const submittedClaim = { ...approvedClaim(), status: CLAIM_STATUS.SUBMITTED, lineItems: [{ ...CLAIM_LINE, approvedThisPeriod: null }], approvedSubtotal: null, approvedGst: null, approvedTotal: null }

// The claim-sourced invoice exactly as the editor seeds it: one line per claim
// line at approvedThisPeriod, GST per line, retention carried from the claim.
const claimLines = [{ poLineIndex: 0, costCodeId: 'c', costCodeName: 'C', description: 'Slab', amount: 300, taxCode: 'gst', gstAmount: 30 }]
const claimInvoice = (status, over = {}) => ({
  id: 'si1', invoiceNumber: 'SI-0001', supplierInvoiceNumber: 'A-1', status, source: SI_SOURCE.PROGRESS_CLAIM,
  poId: 'po', poNumber: 'PO-0001', progressClaimId: 'cl1', claimNumber: 'PC-0001', dueDate: '2026-11-15',
  lineItems: claimLines, ...invoiceTotals(claimLines, 0), ...over,
})

const src = ({ progressClaims = [], supplierInvoices = [] } = {}) => ({
  costCodes: [{ id: 'c', code: 'C', name: 'C', isActive: true }],
  budgetLines: [{ id: 'b', costCodeId: 'c', budgeted: 1000 }],
  purchaseOrders: [PO], progressClaims, supplierInvoices, supplierCreditNotes: [], variations: [],
  forecastLines: [{ id: 'c', costCodeId: 'c', uncommittedCostToComplete: 150 }],
})
const row = (s) => buildForecastRows(s).map(r => composeForecastRow(r, r.storedUncommittedCostToComplete)).find(r => r.costCodeId === 'c')
const figures = (s) => {
  const r = row(s); const t = projectForecastTotals(s)
  const ap = classifyInvoiceBalances(supplierInvoiceReconciliationRows(s.supplierInvoices, [], [], {}), NOW)
  return {
    actual: r.actual, remainingCommitted: r.remainingCommitted, costToComplete: r.costToComplete,
    forecastFinalCost: r.forecastFinalCost, variance: r.varianceToBudget, overBudget: r.overBudget,
    claimsAwaitingInvoice: t.approvedClaimsAwaitingInvoice,
    apTimed: Object.values(ap.byMonth).reduce((a, b) => a + b, 0), apPastDue: ap.pastDue, apUntimed: ap.noDueDate,
    costBasis: r.remainingCommitted + t.approvedClaimsAwaitingInvoice + 150,
  }
}

describe('lifecycle — the 300 is counted once at every step', () => {
  const noClaim   = figures(src())
  const submitted = figures(src({ progressClaims: [submittedClaim] }))
  const approved  = figures(src({ progressClaims: [approvedClaim()] }))
  const drafted   = figures(src({ progressClaims: [approvedClaim()], supplierInvoices: [claimInvoice(SI_STATUS.DRAFT)] }))
  const readied   = figures(src({ progressClaims: [approvedClaim()], supplierInvoices: [claimInvoice(SI_STATUS.APPROVED)] }))
  const cancelled = figures(src({ progressClaims: [approvedClaim()], supplierInvoices: [claimInvoice(SI_STATUS.CANCELLED)] }))
  const posted    = figures(src({ progressClaims: [approvedClaim()], supplierInvoices: [claimInvoice(SI_STATUS.POSTED)] }))

  it('no claim / submitted claim: nothing recognised, full line committed', () => {
    for (const f of [noClaim, submitted]) {
      expect(f).toMatchObject({ actual: 0, remainingCommitted: 800, costToComplete: 950, forecastFinalCost: 950, claimsAwaitingInvoice: 0, apTimed: 0 })
    }
  })

  it('approved claim, no invoice: Actual 300, Remaining Committed 500, Cost to Complete 650, FFC 950 — the 300 moved, it was not added', () => {
    expect(approved).toMatchObject({ actual: 300, remainingCommitted: 500, costToComplete: 650, forecastFinalCost: 950, variance: 50, overBudget: false })
    expect(approved.forecastFinalCost).toBe(noClaim.forecastFinalCost)
    // Cash: the 300 is recognised cost but future cash — carried once, as the claim basis.
    expect(approved.claimsAwaitingInvoice).toBe(300)
    expect(approved.apTimed).toBe(0)
    expect(approved.costBasis).toBe(500 + 300 + 150)
    expect(approved.costBasis).toBe(noClaim.costBasis)   // 800 + 0 + 150 — the future-cost basis did not move either
  })

  it('a DRAFT, APPROVED or CANCELLED-before-posting claim-sourced invoice changes nothing', () => {
    for (const f of [drafted, readied, cancelled]) expect(f).toEqual(approved)
    expect(invoicedClaimIds([claimInvoice(SI_STATUS.CANCELLED)]).has('cl1')).toBe(false)
  })

  it('POSTED: the invoice replaces the claim in Actual and in the netting; FFC and the cost basis are unchanged; cash moves from the claim basis to the AP balance', () => {
    expect(posted).toMatchObject({ actual: 300, remainingCommitted: 500, costToComplete: 650, forecastFinalCost: 950, variance: 50 })
    expect(posted.claimsAwaitingInvoice).toBe(0)
    expect(posted.apTimed).toBe(330)                      // 300 + 30 GST, timed in 2026-11
    expect(posted.costBasis).toBe(500 + 0 + 150)          // ex-GST future cost basis EXCLUDES the posted invoice — it is now an AP balance timed by due date
    expect(invoicedClaimIds([claimInvoice(SI_STATUS.POSTED)]).has('cl1')).toBe(true)
  })

  it('project totals agree with the row at every step', () => {
    for (const s of [src(), src({ progressClaims: [approvedClaim()] }), src({ progressClaims: [approvedClaim()], supplierInvoices: [claimInvoice(SI_STATUS.POSTED)] })]) {
      const t = projectForecastTotals(s); const r = row(s)
      expect(t.forecastFinalCost).toBe(r.forecastFinalCost)
      expect(t.remainingCommitted).toBe(r.remainingCommitted)
      expect(t.actual).toBe(r.actual)
      expect(t.forecastFinalCost).toBe(950)
    }
  })
})

describe('partial claim-sourced invoices are prohibited — the state cannot be reached through the app', () => {
  it('claimReconciliationError refuses any invoice that does not pay exactly the certified GST and total', () => {
    const half = [{ ...claimLines[0], amount: 150, gstAmount: 15 }]
    expect(claimReconciliationError(invoiceTotals(half, 0), { approvedGst: 30, approvedTotal: 330 })).toMatch(/does not reconcile/)
    expect(claimReconciliationError(invoiceTotals(claimLines, 0), { approvedGst: 30, approvedTotal: 330 })).toBeNull()
    // Retention cannot be used to pay less either: the payable must equal the claim's approved total.
    expect(claimReconciliationError(invoiceTotals(claimLines, 100), { approvedGst: 30, approvedTotal: 330 })).toMatch(/does not reconcile/)
  })

  it('…and the guard is enforced in the create hook and the editor, not only in the library', () => {
    expect(read('hooks/useSupplierInvoices.jsx')).toMatch(/if \(source === SI_SOURCE\.PROGRESS_CLAIM\) \{\s*const reconcileError = claimReconciliationError\(/)
    expect(read('pages/project/ProjectInvoices.jsx')).toContain('claimReconciliationError(totals, { approvedGst: claim.approvedGst, approvedTotal: claim.approvedTotal })')
  })

  it('one approved claim carries one active invoice; a cancelled one frees it; a posted invoice is terminal', () => {
    expect(claimHasActiveInvoice([claimInvoice(SI_STATUS.DRAFT)], 'cl1')).toBe(true)
    expect(claimHasActiveInvoice([claimInvoice(SI_STATUS.POSTED)], 'cl1')).toBe(true)
    expect(claimHasActiveInvoice([claimInvoice(SI_STATUS.CANCELLED)], 'cl1')).toBe(false)
    expect(SI_TRANSITIONS[SI_STATUS.POSTED]).toEqual([])
    expect(canTransition(SI_STATUS.POSTED, SI_STATUS.CANCELLED)).toBe(false)
  })

  it('a second approved claim on the same line is the supported "partial" path — each claim nets and is invoiced on its own', () => {
    const cl2 = approvedClaim({ id: 'cl2', claimNumber: 'PC-0002', lineItems: [{ ...CLAIM_LINE, previouslyApproved: 300, claimedToDate: 500, claimedThisPeriod: 200, approvedThisPeriod: 200 }], approvedSubtotal: 200, approvedGst: 20, approvedTotal: 220 })
    const both = figures(src({ progressClaims: [approvedClaim(), cl2] }))
    expect(both).toMatchObject({ actual: 500, remainingCommitted: 300, forecastFinalCost: 950, claimsAwaitingInvoice: 500 })
    const firstPosted = figures(src({ progressClaims: [approvedClaim(), cl2], supplierInvoices: [claimInvoice(SI_STATUS.POSTED)] }))
    expect(firstPosted).toMatchObject({ actual: 500, remainingCommitted: 300, forecastFinalCost: 950, claimsAwaitingInvoice: 200, apTimed: 330 })
  })
})

describe('cash flow coverage follows the same lifecycle', () => {
  const line = (sourceType, amt) => ({ id: `${sourceType}-${amt}`, status: 'active', monthKey: '2026-11', direction: 'out', basis: 'gross', amount: amt * 1.1, sourceAmountExGst: amt, sourceType, costCodeId: 'c', costCodeName: 'C', description: 'd' })

  it('an approved uninvoiced claim is timed against its own basis; once posted that basis is gone and the AP balance is timed by due date', () => {
    const approved = projectForecastTotals(src({ progressClaims: [approvedClaim()] }))
    const cov = costCoverage({ remainingCommittedTotal: approved.remainingCommitted, uninvoicedClaimTotal: approved.approvedClaimsAwaitingInvoice, uncommittedCtcTotal: approved.uncommittedCostToComplete, lines: [line('remaining_committed', 500), line('uninvoiced_claim', 300), line('uncommitted_ctc', 150)] })
    expect(cov.pct).toBe(100)
    expect(untimedRemainingCommitted({ remainingCommittedTotal: 500, lines: [line('remaining_committed', 500)] })).toBe(0)
    expect(untimedUninvoicedClaims({ uninvoicedClaimTotal: 300, lines: [] })).toBe(300)

    const posted = projectForecastTotals(src({ progressClaims: [approvedClaim()], supplierInvoices: [claimInvoice(SI_STATUS.POSTED)] }))
    expect(posted.approvedClaimsAwaitingInvoice).toBe(0)
    // A stale uninvoiced_claim line now covers a zero basis — it does not shrink anything else.
    expect(untimedRemainingCommitted({ remainingCommittedTotal: posted.remainingCommitted, lines: [line('uninvoiced_claim', 300)] })).toBe(500)
    expect(untimedUninvoicedClaims({ uninvoicedClaimTotal: 0, lines: [line('uninvoiced_claim', 300)] })).toBe(0)
  })
})
