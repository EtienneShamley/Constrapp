import { describe, it, expect } from 'vitest'
import {
  SI_STATUS, SI_SOURCE, TAX_CODE,
  allocateGstCents, allocateClaimSourcedLineGst, claimSourcedCertifiedGst, rebuildClaimSourcedLines,
  buildInvoiceLine, invoiceTotals, claimReconciliationError, claimSourcedDriftError, invoicedClaimIds,
  invoicedByCostCode, postedInvoicedByPoLine,
} from '../../src/lib/supplierInvoices'
import { claimTotals, CLAIM_STATUS, actualClaimsByCostCode } from '../../src/lib/progressClaims'
import { PO_STATUS, roundMoney } from '../../src/lib/purchaseOrders'
import { remainingCommittedByPoLine } from '../../src/lib/purchaseOrders'
import { buildForecastRows, composeForecastRow } from '../../src/lib/forecast'
import { projectForecastTotals } from '../../src/lib/margin'
import { supplierInvoiceReconciliationRows, payablesSummary } from '../../src/lib/supplierPayments'

// ── GST boundary hotfix, finding F3 — claim-sourced GST apportionment ─────────
//
// A progress claim certifies GST once, on its net total (claimTotals). A
// claim-sourced supplier invoice stores GST per line, and summing per-line 10%
// roundings cannot reproduce one rounding of the total: three certified lines
// of 10.05 give 1.01 × 3 = 3.03 against a certified 3.02, so the create-time
// guard (claimReconciliationError) refused the invoice and the approved claim
// stayed "awaiting invoice" with no app path. The certified GST is now
// APPORTIONED across the taxable lines in whole cents — largest remainder,
// ties by line index, residual spread one cent at a time — so the invoice's
// GST total equals the certified GST plus this invoice's own retention GST by
// construction, while every amount, tax code, identity and cost code is
// untouched and the claim itself is never read for an edit nor ever written.

const cents = (n) => Math.round(roundMoney(n) * 100)

const claimLine = (amount, idx, over = {}) => ({
  poLineIndex: idx, costCodeId: `cc${idx}`, costCodeName: `CC ${idx}`, description: `Line ${idx + 1}`,
  poLineTotal: 1000, previouslyApproved: 0, claimedToDate: amount, claimedThisPeriod: amount, approvedThisPeriod: amount,
  ...over,
})

// The approved claim exactly as the approve transaction writes it: certified
// line amounts and claimTotals over them with the stored retention.
function approvedClaim(amounts, retention = 0, over = {}) {
  const totals = claimTotals(amounts, retention)
  return {
    id: 'cl1', claimNumber: 'PC-0001', status: CLAIM_STATUS.APPROVED, poId: 'po', poNumber: 'PO-0001',
    supplierId: 's1', supplierName: 'BuildCo', retention: totals.retention,
    lineItems: amounts.map((a, i) => claimLine(a, i)),
    approvedSubtotal: totals.subtotal, approvedGst: totals.gst, approvedTotal: totals.total,
    ...over,
  }
}

// The editor's CREATE build for a claim (ProjectInvoices.jsx → perLine, then
// allocateClaimSourcedLineGst), followed by the hook's idempotent re-application.
function buildFromClaim(claim, taxCodes = []) {
  const perLine = claim.lineItems.map((li, idx) => buildInvoiceLine(li, {
    poLineIndex: li.poLineIndex,
    amount: roundMoney(li.approvedThisPeriod || 0),
    taxCode: taxCodes[idx] || TAX_CODE.GST,
    gstFromUnroundedAmount: true,
  }))
  const page = allocateClaimSourcedLineGst(perLine, { certifiedGst: claim.approvedGst, retention: claim.retention })
  const hook = allocateClaimSourcedLineGst(page, { certifiedGst: claim.approvedGst, retention: claim.retention })
  return { perLine, page, hook }
}

const floorCents = (c) => Math.trunc(c / 10)

// ── allocateGstCents — the integer core ──────────────────────────────────────

describe('allocateGstCents — deterministic whole-cent apportionment', () => {
  it('three lines of 10.05 reconcile to a certified 3.02: 1.01 + 1.01 + 1.00', () => {
    expect(allocateGstCents([1005, 1005, 1005], 302)).toEqual([101, 101, 100])
  })

  it('gives the residual to the largest remainders first, ties to the lower line index', () => {
    // exact: 100.7, 100.3, 100.7 cents → floors 100 ×3; target 302 → two cents
    // to the two .7 lines (indexes 0 and 2), none to the .3 line.
    expect(allocateGstCents([1007, 1003, 1007], 302)).toEqual([101, 100, 101])
    // equal remainders, one cent → the first line
    expect(allocateGstCents([1005, 1005], 201)).toEqual([101, 100])
  })

  it('preserves the exact target for every residual the two roundings can produce', () => {
    // 1005 ×3: Σ exact = 301.5 cents. Targets within two cents of that are the
    // only ones a net-GST + retention-GST composition can reach.
    for (const target of [300, 301, 302, 303]) {
      const out = allocateGstCents([1005, 1005, 1005], target)
      expect(out, `target ${target}`).not.toBeNull()
      expect(out.reduce((a, b) => a + b, 0)).toBe(target)
    }
  })

  it('spreads a residual across every taxable line before any line receives a second cent', () => {
    // exact 10.1 ×2 → floors 10, 10; target 22 (within the two-cent ceiling) →
    // residual 2: one cent EACH, never two on the first line.
    expect(allocateGstCents([101, 101], 22)).toEqual([11, 11])
    expect(allocateGstCents([101, 101], 21)).toEqual([11, 10])
    // a single line absorbs a two-cent residual by cycling, one cent per pass
    expect(allocateGstCents([1000], 102)).toEqual([102])
  })

  it('takes a negative residual back in smallest-remainder order, one cent per pass', () => {
    // exact 10.0 ×3 → floors 10 ×3 = 30; target 29 → one cent from line 0 (all r=0).
    expect(allocateGstCents([100, 100, 100], 29)).toEqual([9, 10, 10])
    // exact 10.3, 10.0 → floors 10, 10; target 19 → the .0 line (index 1) gives first.
    expect(allocateGstCents([103, 100], 19)).toEqual([10, 9])
  })

  it('never allocates to a non-taxable (null) or zero-amount line', () => {
    expect(allocateGstCents([1005, null, 1005], 201)).toEqual([101, 0, 100])
    expect(allocateGstCents([1005, 0, 1005], 201)).toEqual([101, 0, 100])
    // even when every taxable line takes a cent
    expect(allocateGstCents([101, null, 101], 22)).toEqual([11, 0, 11])
  })

  it('handles empty and all-non-taxable inputs: zero target only', () => {
    expect(allocateGstCents([], 0)).toEqual([])
    expect(allocateGstCents([], 1)).toBeNull()
    expect(allocateGstCents([null, null], 0)).toEqual([0, 0])
    expect(allocateGstCents([null, 0], 1)).toBeNull()
  })

  it('refuses a target more than two cents from 10% of the taxable lines — never fabricates a match', () => {
    expect(allocateGstCents([1005, 1005, 1005], 299)).toBeNull()   // 2.5 cents low
    expect(allocateGstCents([1005, 1005, 1005], 305)).toBeNull()   // 3.5 cents high
    expect(allocateGstCents([100000], 10003)).toBeNull()
    expect(allocateGstCents([100000], 10002)).toEqual([10002])    // the two-cent ceiling itself
  })

  it('refuses malformed input safely: negative, fractional, non-array, bad target', () => {
    expect(allocateGstCents([-5, 1005], 100)).toBeNull()
    expect(allocateGstCents([10.5, 1005], 100)).toBeNull()
    expect(allocateGstCents('x', 0)).toBeNull()
    expect(allocateGstCents([1005], -1)).toBeNull()
    expect(allocateGstCents([1005], 100.5)).toBeNull()
    expect(allocateGstCents([1005], NaN)).toBeNull()
  })

  it('refuses a take-back that would drive a line below zero', () => {
    // exact 0.1 cent → floor 0; target 0 is fine, −1 is impossible.
    expect(allocateGstCents([1], 0)).toEqual([0])
    expect(allocateGstCents([1, 1], 0)).toEqual([0, 0])
  })

  it('is a pure function of the ordered inputs — the same cents land on the same lines every time', () => {
    const a = allocateGstCents([1007, 1003, 1007, 1005], 403)
    const b = allocateGstCents([1007, 1003, 1007, 1005], 403)
    expect(a).toEqual(b)
    expect(a).toEqual([101, 100, 101, 101])
    // reordering the lines reorders the cents with them (index is only the tie-break)
    expect(allocateGstCents([1003, 1007, 1005, 1007], 403)).toEqual([100, 101, 101, 101])
  })

  it('large line counts: 200 lines of 10.05 — a certified 201.00 places 100 residual cents on the first 100 lines', () => {
    const amounts = Array(200).fill(1005)
    const target = cents(claimTotals(Array(200).fill(10.05), 0).gst)
    expect(target).toBe(20100)
    const out = allocateGstCents(amounts, target)
    expect(out.reduce((a, b) => a + b, 0)).toBe(target)
    expect(out.slice(0, 100).every(v => v === 101)).toBe(true)
    expect(out.slice(100).every(v => v === 100)).toBe(true)
  })

  it('every claim the app can certify apportions exactly, each line within its floor and ceiling plus one', () => {
    // A deterministic sweep over cent-level multi-line claims with and without
    // a cent-level retention — the targets a real claim-sourced invoice sets.
    let seed = 20261103
    const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n }
    for (let trial = 0; trial < 3000; trial++) {
      const n = 1 + rnd(8)
      const amounts = Array.from({ length: n }, () => 1 + rnd(500000))        // cents
      const retentionC = trial % 3 === 0 ? rnd(Math.min(5000, amounts.reduce((a, b) => a + b, 0))) : 0
      const money = amounts.map(c => c / 100)
      const claim = claimTotals(money, retentionC / 100)
      const retentionGst = invoiceTotals(money.map(a => ({ amount: a, taxCode: 'gst', gstAmount: 0 })), retentionC / 100).retentionGst
      const target = cents(claim.gst + retentionGst)
      const out = allocateGstCents(amounts, target)
      expect(out, `trial ${trial} ${JSON.stringify(amounts)} ret ${retentionC}`).not.toBeNull()
      expect(out.reduce((a, b) => a + b, 0)).toBe(target)
      out.forEach((v, i) => {
        expect(v).toBeGreaterThanOrEqual(floorCents(amounts[i]) - 1)
        expect(v).toBeLessThanOrEqual(floorCents(amounts[i]) + 2)
      })
    }
  })
})

// ── allocateClaimSourcedLineGst — the line builder ───────────────────────────

describe('allocateClaimSourcedLineGst — the certified claim GST on the invoice lines', () => {
  it('three certified lines of 10.05 now build an invoice that reconciles to the claim', () => {
    const claim = approvedClaim([10.05, 10.05, 10.05])
    expect(claim.approvedGst).toBe(3.02)
    const { perLine, page, hook } = buildFromClaim(claim)
    // the old per-line rounding, which the guard refused
    expect(invoiceTotals(perLine, 0).gstTotal).toBe(3.03)
    expect(claimReconciliationError(invoiceTotals(perLine, 0), { approvedGst: claim.approvedGst, approvedTotal: claim.approvedTotal })).toMatch(/payable GST/)
    // the apportionment
    expect(page.map(l => l.gstAmount)).toEqual([1.01, 1.01, 1.00])
    const totals = invoiceTotals(page, 0)
    expect(totals.gstTotal).toBe(3.02)
    expect(totals.payableGst).toBe(claim.approvedGst)
    expect(totals.payableTotal).toBe(claim.approvedTotal)
    expect(claimReconciliationError(totals, { approvedGst: claim.approvedGst, approvedTotal: claim.approvedTotal })).toBeNull()
    // the hook's re-application changes nothing
    expect(hook).toEqual(page)
  })

  it('two-line and multi-line claims with cent-level amounts reconcile, with and without retention', () => {
    const cases = [
      [[0.01, 0.34], 0], [[10.05, 20.15], 0], [[33.35, 33.35, 33.35], 0], [[803], 40.15],
      [[101.05, 202.15, 303.25, 404.35], 50.55], [[40.15, 41.05, 80.85], 8.05], [[0.05, 0.05, 0.05, 0.05, 0.05], 0.05],
    ]
    for (const [amounts, retention] of cases) {
      const claim = approvedClaim(amounts, retention)
      const { page } = buildFromClaim(claim)
      const totals = invoiceTotals(page, claim.retention)
      expect(claimReconciliationError(totals, { approvedGst: claim.approvedGst, approvedTotal: claim.approvedTotal }), JSON.stringify(amounts)).toBeNull()
      expect(cents(totals.gstTotal)).toBe(cents(claim.approvedGst) + cents(totals.retentionGst))
    }
  })

  it('a single whole-dollar line with a cent-level retention still pays exactly the certified figures (803.00 at 5%)', () => {
    const claim = approvedClaim([803], 40.15)
    const { page } = buildFromClaim(claim)
    const totals = invoiceTotals(page, 40.15)
    expect(totals.retention).toBe(40.15)
    expect(totals.payableGst).toBe(claim.approvedGst)
    expect(totals.payableTotal).toBe(claim.approvedTotal)
    expect(claimReconciliationError(totals, { approvedGst: claim.approvedGst, approvedTotal: claim.approvedTotal })).toBeNull()
  })

  it('touches only gstAmount — identity, amount, tax code and cost code are preserved verbatim', () => {
    const claim = approvedClaim([10.05, 10.05, 10.05])
    const { perLine, page } = buildFromClaim(claim)
    const withoutGst = ({ gstAmount, ...rest }) => ({ ...rest, hadGst: typeof gstAmount === 'number' })
    page.forEach((l, i) => {
      expect(withoutGst(l)).toEqual(withoutGst(perLine[i]))
    })
  })

  it('never mutates the certified claim or the input lines', () => {
    const claim = approvedClaim([10.05, 10.05, 10.05])
    const frozen = JSON.stringify(claim)
    const { perLine } = buildFromClaim(claim)
    const before = JSON.stringify(perLine)
    allocateClaimSourcedLineGst(perLine, { certifiedGst: claim.approvedGst, retention: claim.retention })
    expect(JSON.stringify(claim)).toBe(frozen)
    expect(JSON.stringify(perLine)).toBe(before)
  })

  it('does not allocate GST to a non-taxable line, and refuses rather than fake a match when the lines cannot carry the certified GST', () => {
    const claim = approvedClaim([10.05, 10.05, 10.05])
    // one line GST-free: the certified 3.02 is more than two cents above 10% of
    // the remaining taxable lines, so the lines come back UNCHANGED and the
    // reconciliation guard reports it — exactly as before the hotfix.
    const { perLine, page } = buildFromClaim(claim, [TAX_CODE.GST, TAX_CODE.GST_FREE, TAX_CODE.GST])
    expect(page).toEqual(perLine)
    expect(page[1].gstAmount).toBe(0)
    expect(claimReconciliationError(invoiceTotals(page, 0), { approvedGst: claim.approvedGst, approvedTotal: claim.approvedTotal })).toMatch(/payable GST/)
  })

  it('refuses unsupported inputs without corrupting values: negative or sub-cent amounts, missing certified GST', () => {
    const lines = [
      { poLineIndex: 0, costCodeId: 'a', amount: -5, taxCode: 'gst', gstAmount: -0.5 },
      { poLineIndex: 1, costCodeId: 'b', amount: 10.05, taxCode: 'gst', gstAmount: 1.01 },
    ]
    expect(allocateClaimSourcedLineGst(lines, { certifiedGst: 0.5, retention: 0 })).toEqual(lines)
    const subCent = [{ poLineIndex: 0, costCodeId: 'a', amount: 10.005, taxCode: 'gst', gstAmount: 1 }]
    expect(allocateClaimSourcedLineGst(subCent, { certifiedGst: 1, retention: 0 })).toEqual(subCent)
    expect(allocateClaimSourcedLineGst(lines, { certifiedGst: null })).toEqual(lines)
    expect(allocateClaimSourcedLineGst(lines, {})).toEqual(lines)
    expect(allocateClaimSourcedLineGst(null, { certifiedGst: 1 })).toEqual([])
    expect(allocateClaimSourcedLineGst([], { certifiedGst: 1 })).toEqual([])
  })

  it('zero-amount lines (certified at zero) carry no GST and do not disturb the apportionment', () => {
    const claim = approvedClaim([10.05, 0, 10.05])
    const { page } = buildFromClaim(claim)
    expect(page[1].gstAmount).toBe(0)
    expect(cents(invoiceTotals(page, 0).gstTotal)).toBe(cents(claim.approvedGst))
    // and the saved set (zero lines dropped) apportions identically
    const saved = page.filter(l => l.amount > 0)
    const again = allocateClaimSourcedLineGst(saved, { certifiedGst: claim.approvedGst, retention: 0 })
    expect(again.map(l => l.gstAmount)).toEqual(saved.map(l => l.gstAmount))
  })
})

// ── EDIT: the rebuild matches CREATE ─────────────────────────────────────────

describe('rebuildClaimSourcedLines / claimSourcedCertifiedGst — the stored draft reconciles with itself', () => {
  const stored = (amounts, retention) => {
    const claim = approvedClaim(amounts, retention)
    const { page } = buildFromClaim(claim)
    const lines = page.filter(l => l.amount > 0)
    return { claim, invoice: {
      id: 'si1', invoiceNumber: 'SI-0001', status: SI_STATUS.DRAFT, source: SI_SOURCE.PROGRESS_CLAIM, progressClaimId: 'cl1',
      lineItems: lines, ...invoiceTotals(lines, claim.retention),
    } }
  }

  it('derives the certified GST from the stored amounts and retention through the one claim formula', () => {
    const { claim, invoice } = stored([10.05, 10.05, 10.05], 0)
    expect(claimSourcedCertifiedGst(invoice.lineItems, invoice.retention)).toBe(claim.approvedGst)
    const { claim: c2, invoice: i2 } = stored([803], 40.15)
    expect(claimSourcedCertifiedGst(i2.lineItems, i2.retention)).toBe(c2.approvedGst)
  })

  it('rebuilds exactly the lines CREATE stored, so a header edit passes the drift check', () => {
    for (const [amounts, retention] of [[[10.05, 10.05, 10.05], 0], [[803], 40.15], [[33.35, 33.35, 33.35], 10.05]]) {
      const { invoice } = stored(amounts, retention)
      const rebuilt = rebuildClaimSourcedLines(invoice.lineItems, invoice.retention)
      expect(rebuilt.map(l => l.gstAmount)).toEqual(invoice.lineItems.map(l => l.gstAmount))
      expect(claimSourcedDriftError(invoice, invoiceTotals(rebuilt, invoice.retention))).toBeNull()
    }
  })

  it('a pre-hotfix draft whose per-line GST already summed to the certified figure still reconciles', () => {
    // whole-dollar lines never diverged; the rebuild reproduces them unchanged
    const claim = approvedClaim([300, 200], 0)
    const lines = claim.lineItems.map((li, i) => buildInvoiceLine(li, { poLineIndex: i, amount: li.approvedThisPeriod, taxCode: 'gst' }))
    const invoice = { invoiceNumber: 'SI-0002', source: SI_SOURCE.PROGRESS_CLAIM, lineItems: lines, ...invoiceTotals(lines, 0) }
    const rebuilt = rebuildClaimSourcedLines(lines, 0)
    expect(rebuilt).toEqual(lines)
    expect(claimSourcedDriftError(invoice, invoiceTotals(rebuilt, 0))).toBeNull()
  })

  it('still refuses a stored draft whose header totals disagree with the certified GST its lines imply', () => {
    const { invoice } = stored([10.05, 10.05, 10.05], 0)
    const forged = { ...invoice, payableGst: 3.03, gstTotal: 3.03, grossTotal: 33.18, payableTotal: 33.18 }
    const rebuilt = rebuildClaimSourcedLines(forged.lineItems, forged.retention)
    expect(claimSourcedDriftError(forged, invoiceTotals(rebuilt, forged.retention))).toMatch(/no longer reconciles/)
  })
})

// ── FINANCIAL REGRESSION — the apportioned invoice moves exactly what it did ──

describe('FINANCIAL REGRESSION — an apportioned claim-sourced invoice counts once and moves no commitment it should not', () => {
  const PO = { id: 'po', poNumber: 'PO-0001', status: PO_STATUS.SENT, lineItems: [
    { costCodeId: 'cc0', costCodeName: 'A', description: 'a', lineTotal: 500 },
    { costCodeId: 'cc1', costCodeName: 'B', description: 'b', lineTotal: 500 },
    { costCodeId: 'cc2', costCodeName: 'C', description: 'c', lineTotal: 500 },
  ] }
  const claim = approvedClaim([10.05, 10.05, 10.05])
  const { page } = buildFromClaim(claim)
  const lines = page.filter(l => l.amount > 0)
  const invoice = (status) => ({
    id: 'si1', invoiceNumber: 'SI-0001', supplierInvoiceNumber: 'A-1', status, source: SI_SOURCE.PROGRESS_CLAIM,
    poId: 'po', poNumber: 'PO-0001', progressClaimId: 'cl1', claimNumber: 'PC-0001', dueDate: '2026-11-15',
    lineItems: lines, ...invoiceTotals(lines, 0),
  })
  const sources = (supplierInvoices) => ({
    costCodes: ['cc0', 'cc1', 'cc2'].map(id => ({ id, code: id, name: id, isActive: true })),
    budgetLines: ['cc0', 'cc1', 'cc2'].map(id => ({ id: `b-${id}`, costCodeId: id, budgeted: 1000 })),
    purchaseOrders: [PO], progressClaims: [claim], supplierInvoices, supplierCreditNotes: [], variations: [],
    forecastLines: [],
  })
  const totalsOf = (s) => projectForecastTotals(s)
  const rows = (s) => buildForecastRows(s).map(r => composeForecastRow(r, r.storedUncommittedCostToComplete))

  it('Actual recognises the 30.15 once: on the claim before posting, on the invoice after — never both', () => {
    const before = totalsOf(sources([invoice(SI_STATUS.DRAFT)]))
    const after  = totalsOf(sources([invoice(SI_STATUS.POSTED)]))
    expect(roundMoney(before.actual)).toBe(30.15)
    expect(roundMoney(after.actual)).toBe(30.15)
    expect(roundMoney(before.approvedClaimsAwaitingInvoice)).toBe(30.15)
    expect(roundMoney(after.approvedClaimsAwaitingInvoice)).toBe(0)
    expect(invoicedClaimIds([invoice(SI_STATUS.POSTED)]).has('cl1')).toBe(true)
    expect(invoicedByCostCode([invoice(SI_STATUS.POSTED)])).toEqual({ cc0: 10.05, cc1: 10.05, cc2: 10.05 })
    expect(actualClaimsByCostCode([claim], invoicedClaimIds([invoice(SI_STATUS.POSTED)]))).toEqual({})
  })

  it('Remaining Committed nets each PO line once, identically before and after posting, and FFC is unchanged', () => {
    const before = rows(sources([invoice(SI_STATUS.DRAFT)]))
    const after  = rows(sources([invoice(SI_STATUS.POSTED)]))
    for (const cc of ['cc0', 'cc1', 'cc2']) {
      const b = before.find(r => r.costCodeId === cc); const a = after.find(r => r.costCodeId === cc)
      expect(roundMoney(b.remainingCommitted)).toBe(489.95)
      expect(roundMoney(a.remainingCommitted)).toBe(489.95)
      expect(roundMoney(b.forecastFinalCost)).toBe(roundMoney(a.forecastFinalCost))
    }
    const invoiced = postedInvoicedByPoLine([invoice(SI_STATUS.POSTED)])
    expect(invoiced).toEqual({ po: { 0: 10.05, 1: 10.05, 2: 10.05 } })
    expect(remainingCommittedByPoLine([PO], invoiced, {}, {})).toEqual({ po: { 0: 489.95, 1: 489.95, 2: 489.95 } })
  })

  it('Accounts Payable carries the certified payable total — the GST apportionment changes no payable figure', () => {
    const posted = invoice(SI_STATUS.POSTED)
    expect(posted.payableTotal).toBe(claim.approvedTotal)
    expect(posted.payableGst).toBe(claim.approvedGst)
    const rows = supplierInvoiceReconciliationRows([posted], [], [], {})
    expect(rows).toHaveLength(1)
    expect(roundMoney(rows[0].remaining)).toBe(claim.approvedTotal)
    const summary = payablesSummary([posted], [], [], {})
    expect(roundMoney(summary.remaining)).toBe(claim.approvedTotal)
  })
})
