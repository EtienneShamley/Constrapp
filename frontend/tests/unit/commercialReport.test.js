import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  buildCommercialReport, isReportExportable, compareReportRows, budgetSourceCaption,
  REPORT_SOURCES, REPORT_DEPENDENCIES, FIGURE_KIND,
} from '../../src/lib/commercialReport'
import {
  commercialReportCsv, commercialReportFilename, figureCsvValue, localDateKey, CSV_MARKER,
} from '../../src/lib/commercialReportCsv'
import { csvCell, csvRows, csvMoney, sanitizeCsvText, isFormulaLike, filenameSlug } from '../../src/lib/csv'
import { projectSnapshot, FIGURE_STATE, MARGIN_NOT_ESTABLISHED, SNAPSHOT_SOURCES } from '../../src/lib/projectSnapshot'
import { projectForecastTotals, computeMargin } from '../../src/lib/margin'
import { resolveBudgetSource, budgetLinesFor, originalApprovedBudgetFor, BUDGET_SOURCE } from '../../src/lib/budgetApproval'
import { claimedPendingByCostCode } from '../../src/lib/progressClaims'
import { receivablesSummary } from '../../src/lib/clientReceipts'
import { receivableContext } from '../../src/lib/clientReceivables'
import { issuedInvoice, creditNoteFor, releaseFor } from '../fixtures/clientReceivableDocs'

// ── L2-A Commercial Report ───────────────────────────────────────────────────
//
// The report must be a COMPOSITION of the existing selectors (projectSnapshot,
// projectForecastRows / forecastRollups, computeMargin, the claim and cash
// selectors), never a second implementation. Fixtures are rich enough that
// every figure is non-zero, so a test cannot pass by both sides being 0.
// Structural assertions read SOURCE (plain Node runner, no jsdom — ADR-26).

const read = (rel) => readFileSync(fileURLToPath(new URL(`../../src/${rel}`, import.meta.url)), 'utf8')
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '')

// ── Fixtures ─────────────────────────────────────────────────────────────────

const budgetLines = [
  { id: 'bl1', costCodeId: 'cc1', costCodeName: '03-100 — Concrete', budgeted: 1000 },
  { id: 'bl2', costCodeId: 'cc2', costCodeName: '03-200 — Formwork', budgeted: 600 },
]

const purchaseOrders = [
  { id: 'po1', status: 'sent', lineItems: [
    { costCodeId: 'cc1', lineTotal: 800 },
    { costCodeId: 'cc2', lineTotal: 400 },
  ] },
  { id: 'po9', status: 'draft', lineItems: [{ costCodeId: 'cc1', lineTotal: 99999 }] },
]

const inv1 = {
  id: 'inv1', invoiceNumber: 'SI-0001', supplierInvoiceNumber: 'INV-100',
  status: 'posted', supplierId: 'sup1', supplierName: 'Ace Concrete', currency: 'AUD', poId: 'po1',
  lineItems: [
    { poLineIndex: 0, costCodeId: 'cc1', costCodeName: '03-100 — Concrete', description: 'Slab', amount: 600, taxCode: 'gst', gstAmount: 60 },
    { poLineIndex: 1, costCodeId: 'cc2', costCodeName: '03-200 — Formwork', description: 'Forms', amount: 400, taxCode: 'gst', gstAmount: 40 },
  ],
  retention: 0, retentionGst: 0, retentionTotal: 0,
  subtotal: 1000, gstTotal: 100, grossTotal: 1100, net: 1000, payableGst: 100, payableTotal: 1100,
  dueDate: '2026-01-31',
}

const supplierInvoices = [inv1, { ...inv1, id: 'inv9', status: 'draft' }]

const progressClaims = [
  // Certified → Actual (cc4).
  { id: 'cl1', status: 'approved', poId: 'po2', lineItems: [{ costCodeId: 'cc4', approvedThisPeriod: 250, claimedThisPeriod: 250 }] },
  // Submitted → Claimed only (cc1), never Actual.
  { id: 'cl2', status: 'submitted', poId: 'po1', lineItems: [{ costCodeId: 'cc1', claimedThisPeriod: 120, approvedThisPeriod: 9999 }] },
  // Under review on a code that appears NOWHERE else → a claim-only row.
  { id: 'cl3', status: 'under_review', poId: 'po3', lineItems: [{ costCodeId: 'cc9', costCodeName: '09-900 — Painting', claimedThisPeriod: 75 }] },
  // Draft → nothing.
  { id: 'cl4', status: 'draft', poId: 'po1', lineItems: [{ costCodeId: 'cc1', claimedThisPeriod: 5000 }] },
]

const supplierCreditNotes = [{
  id: 'cn1', creditNumber: 'SCN-0001', status: 'posted', docType: 'credit_note',
  supplierInvoiceId: 'inv1', invoiceNumber: 'SI-0001', supplierInvoiceNumber: 'INV-100',
  supplierId: 'sup1', supplierName: 'Ace Concrete', supplierCreditReference: 'CN-9',
  creditDate: '2026-02-01', reason: 'Over-claimed quantities',
  lineItems: [{ costCodeId: 'cc1', costCodeName: '03-100 — Concrete', description: 'Credit', amount: 100, taxCode: 'gst', gstAmount: 10 }],
  subtotal: 100, gstTotal: 10, grossTotal: 110, currency: 'AUD',
}]

const variations = [
  { id: 'v1', variationType: 'client', status: 'approved', approvedSubtotal: 2000, lineItems: [] },
  { id: 'v2', variationType: 'client', status: 'submitted', submittedSubtotal: 900, lineItems: [] },
  { id: 'v3', variationType: 'supplier', status: 'approved', approvedSubtotal: 50, lineItems: [{ costCodeId: 'cc1', approvedAmount: 50 }] },
  { id: 'v4', variationType: 'supplier', status: 'submitted', submittedSubtotal: 70, lineItems: [{ costCodeId: 'cc2', submittedAmount: 70 }] },
]

const forecastLines = [
  { id: 'cc1', costCodeId: 'cc1', uncommittedCostToComplete: 150 },
  { id: 'cc2', costCodeId: 'cc2', uncommittedCostToComplete: null },
]

const baseline = { originalContractValue: 10000, originalApprovedBudget: 1500 }

const supplierPayments = [{
  id: 'pay1', paymentNumber: 'SP-0001', status: 'posted', supplierId: 'sup1', supplierName: 'Ace Concrete',
  paymentDate: '2026-02-02', amount: 500, allocatedTotal: 500, unallocatedAmount: 0,
  allocations: [{ supplierInvoiceId: 'inv1', invoiceNumber: 'SI-0001', supplierInvoiceNumber: 'INV-100', allocatedAmount: 500 }],
}, { id: 'pay2', status: 'draft', amount: 7777, paymentDate: '2026-02-03', allocations: [] }]

const clientInvoices = [
  { id: 'ci1', invoiceNumber: 'CI-0001', status: 'issued', clientId: 'c1', clientName: 'Owner', grossTotal: 3300, subtotal: 3000, gstTotal: 300, invoiceDate: '2026-02-01', dueDate: '2026-03-01' },
  { id: 'ci2', invoiceNumber: 'CI-0002', status: 'draft', clientId: 'c1', clientName: 'Owner', grossTotal: 99999 },
]

const clientReceipts = [
  { id: 'cr1', receiptNumber: 'CR-0001', status: 'posted', clientId: 'c1', clientName: 'Owner', receiptDate: '2026-02-10',
    amount: 1100, allocatedTotal: 1100, unallocatedAmount: 0, allocations: [{ clientInvoiceId: 'ci1', allocatedAmount: 1100 }] },
  { id: 'cr2', status: 'draft', amount: 5000, receiptDate: '2026-02-11', allocations: [] },
]

const costCodes = [
  { id: 'cc1', code: '03-100', name: 'Concrete' },
  { id: 'cc2', code: '03-200', name: 'Formwork' },
  { id: 'cc4', code: '04-100', name: 'Masonry' },
]

const SOURCES = {
  budgetLines, approvedBudget: null, purchaseOrders, progressClaims, supplierInvoices, supplierCreditNotes,
  variations, forecastLines, baseline, supplierPayments, retentionReleases: [],
  clientInvoices, clientReceipts, costCodes,
}

const settled = (over = {}) => ({
  ...Object.fromEntries(REPORT_SOURCES.map(s => [s, { loading: false, error: false }])),
  ...over,
})

const PROJECT = { id: 'p1', name: 'Gold Coast Apartments' }
const build = (sources = SOURCES, sourceStates = settled(), currencyCode = 'AUD', project = PROJECT) =>
  buildCommercialReport({ project, currencyCode, sources, sourceStates })

const fig = (report, section, key) => report[section].find(i => i.key === key).figure

// The selectors the report is meant to carry, called directly.
const directSnapshot = projectSnapshot({ sources: SOURCES, sourceStates: settled(), currencyCode: 'AUD' })
const directTotals = projectForecastTotals({ budgetLines, purchaseOrders, progressClaims, supplierInvoices, supplierCreditNotes, variations, forecastLines })
const directMargin = computeMargin({ baseline, variations, forecastFinalCost: directTotals.forecastFinalCost, purchaseOrders })

// ── 1. Financial calculation consistency ─────────────────────────────────────

describe('the report carries the existing selectors unchanged', () => {
  const r = build()

  it('fixtures exercise every summary figure (no 0 === 0 passes)', () => {
    for (const item of r.summary) {
      expect(item.figure.state, item.key).toBe(FIGURE_STATE.READY)
      expect(item.figure.value, item.key).not.toBe(0)
      expect(item.figure.value, item.key).not.toBeNull()
    }
  })

  it('headline figures equal the Dashboard snapshot (the same composition)', () => {
    expect(fig(r, 'summary', 'approvedBudget').value).toBe(directSnapshot.approvedBudget.value)
    expect(fig(r, 'summary', 'committed').value).toBe(directSnapshot.remainingCommitted.value)
    expect(fig(r, 'summary', 'actual').value).toBe(directSnapshot.actual.value)
    expect(fig(r, 'summary', 'forecastFinalCost').value).toBe(directSnapshot.forecastFinalCost.value)
    expect(fig(r, 'summary', 'varianceToBudget').value).toBe(directSnapshot.varianceToBudget.value)
    expect(fig(r, 'summary', 'currentContractSum').value).toBe(directSnapshot.currentContractSum.value)
    expect(fig(r, 'summary', 'forecastGrossProfit').value).toBe(directSnapshot.margin.grossProfit)
    expect(fig(r, 'summary', 'forecastMarginPct').value).toBe(directSnapshot.margin.marginPct)
  })

  it('regression pin — hand-derived values', () => {
    // cc1: actual 600 − 100 credit = 500; PO 800 − 600 invoiced = 200 committed; CTC 150
    // cc2: actual 400; committed 0; unforecast
    // cc4: certified claim 250
    expect(fig(r, 'summary', 'approvedBudget').value).toBe(1600)
    expect(fig(r, 'summary', 'actual').value).toBe(1150)
    expect(fig(r, 'summary', 'committed').value).toBe(200)
    expect(fig(r, 'summary', 'costToComplete').value).toBe(350)
    expect(fig(r, 'summary', 'forecastFinalCost').value).toBe(1500)
    expect(fig(r, 'summary', 'varianceToBudget').value).toBe(1600 - 1500)
    expect(fig(r, 'summary', 'originalContractValue').value).toBe(10000)
    expect(fig(r, 'summary', 'currentContractSum').value).toBe(12000)
    expect(fig(r, 'summary', 'forecastRevenue').value).toBe(12000)
    expect(fig(r, 'summary', 'forecastGrossProfit').value).toBe(10500)
    expect(fig(r, 'summary', 'forecastMarginPct').value).toBe(87.5)
    expect(fig(r, 'summary', 'claimed').value).toBe(195)
  })

  it('cost to complete equals the forecast rollup; FFC = actual + cost to complete', () => {
    expect(fig(r, 'summary', 'costToComplete').value).toBe(directTotals.costToComplete)
    expect(fig(r, 'summary', 'forecastFinalCost').value)
      .toBe(fig(r, 'summary', 'actual').value + fig(r, 'summary', 'costToComplete').value)
  })

  it('cost-code totals equal the headline figures (rows and summary cannot drift)', () => {
    const t = r.costCodes.totals
    expect(t.approvedBudget).toBe(fig(r, 'summary', 'approvedBudget').value)
    expect(t.committed).toBe(fig(r, 'summary', 'committed').value)
    expect(t.actual).toBe(fig(r, 'summary', 'actual').value)
    expect(t.forecastFinalCost).toBe(fig(r, 'summary', 'forecastFinalCost').value)
    expect(t.costToComplete).toBe(fig(r, 'summary', 'costToComplete').value)
    expect(t.varianceToBudget).toBe(fig(r, 'summary', 'varianceToBudget').value)
    expect(t.claimed).toBe(fig(r, 'summary', 'claimed').value)
  })

  it('forecast revenue and margin are computeMargin outputs', () => {
    expect(fig(r, 'summary', 'forecastRevenue').value).toBe(directMargin.forecastRevenue)
    expect(fig(r, 'summary', 'forecastMarginPct').value).toBe(directMargin.forecastMarginPct)
  })

  it('cost-code names come from the company cost codes; codes without one keep the snapshot name', () => {
    const names = r.costCodes.rows.map(x => x.costCodeName)
    expect(names).toContain('03-100 — Concrete')
    expect(names).toContain('04-100 — Masonry')
    expect(names).toContain('09-900 — Painting')
  })
})

// ── 2. Approved budget selection (ADR-70/71) ─────────────────────────────────

describe('approved budget selection', () => {
  const approvedBudget = {
    pointer: { activeApprovalId: 'ba1', originalApprovalId: 'ba1', versionCount: 1 },
    header: { id: 'ba1', status: 'approved', version: 1, entryCount: 2, total: 1700, currency: 'AUD', reason: 'Initial' },
    snapshot: { id: 'ba1', entryCount: 2, total: 1700, currency: 'AUD', entries: [
      { lineId: 'bl1', costCodeId: 'cc1', costCodeName: '03-100 — Concrete', budgeted: 1200 },
      { lineId: 'bl2', costCodeId: 'cc2', costCodeName: '03-200 — Formwork', budgeted: 500 },
    ] },
    originalRequested: true,
  }

  it('an approved version is the budget source — never the working lines', () => {
    const r = build({ ...SOURCES, approvedBudget })
    const resolved = resolveBudgetSource({ approvedBudget, budgetLines, currencyCode: 'AUD' })
    expect(resolved.kind).toBe(BUDGET_SOURCE.APPROVED)
    expect(fig(r, 'summary', 'approvedBudget').value).toBe(1700)
    expect(r.costCodes.rows.find(x => x.costCodeId === 'cc1').approvedBudget).toBe(1200)
    expect(r.budgetSourceCaption).toBe('Approved version 1')
    // Margin movement's original follows version 1, as computeMargin is called.
    const direct = computeMargin({
      baseline, variations, purchaseOrders,
      forecastFinalCost: projectForecastTotals({ budgetLines: budgetLinesFor(resolved), purchaseOrders, progressClaims, supplierInvoices, supplierCreditNotes, variations, forecastLines }).forecastFinalCost,
      originalApprovedBudget: originalApprovedBudgetFor(resolved),
    })
    expect(fig(r, 'summary', 'forecastGrossProfit').value).toBe(direct.forecastGrossProfit)
  })

  it('without an approved version the working budget is labelled as not approved', () => {
    const r = build()
    expect(r.budgetSource.kind).toBe(BUDGET_SOURCE.WORKING)
    expect(r.budgetSourceCaption).toBe('Working budget (not approved)')
  })

  it('a failed approved-budget read makes every budget figure Unavailable — never zero', () => {
    const r = build(SOURCES, settled({ approvedBudget: { loading: false, error: true } }))
    expect(fig(r, 'summary', 'approvedBudget').state).toBe(FIGURE_STATE.UNAVAILABLE)
    expect(fig(r, 'summary', 'approvedBudget').value).toBeNull()
    expect(fig(r, 'summary', 'varianceToBudget').state).toBe(FIGURE_STATE.UNAVAILABLE)
    expect(r.costCodes.state).toBe(FIGURE_STATE.UNAVAILABLE)
    expect(r.costCodes.rows).toEqual([])
    // Figures that do not read the budget stay available.
    expect(fig(r, 'summary', 'actual').state).toBe(FIGURE_STATE.READY)
    expect(fig(r, 'cash', 'cashIn').state).toBe(FIGURE_STATE.READY)
  })

  it('budget source captions', () => {
    expect(budgetSourceCaption({ kind: BUDGET_SOURCE.APPROVED, version: 2, adjustmentCount: 1 })).toBe('Approved version 2 + 1 adjustment')
    expect(budgetSourceCaption({ kind: BUDGET_SOURCE.LOADING })).toBe('Loading')
    expect(budgetSourceCaption({ kind: BUDGET_SOURCE.UNAVAILABLE })).toBe('Unavailable')
  })
})

// ── 3. Commitments vs actual; claims vs invoices vs payments ─────────────────

describe('commitment, claim, actual and cash semantics', () => {
  const r = build()
  const row = (id) => r.costCodes.rows.find(x => x.costCodeId === id)

  it('a submitted / under-review claim is Claimed, never Actual', () => {
    expect(row('cc1').claimed).toBe(120)
    expect(row('cc1').actual).toBe(500)          // the 9999 approvedThisPeriod on a submitted claim is ignored
    expect(row('cc9').claimed).toBe(75)
    expect(row('cc9').actual).toBe(0)
    expect(row('cc9').committed).toBe(0)
  })

  it('Claimed equals claimedPendingByCostCode (drafts excluded)', () => {
    const map = claimedPendingByCostCode(progressClaims)
    for (const x of r.costCodes.rows) expect(x.claimed).toBe(map[x.costCodeId] || 0)
    expect(map.cc1).toBe(120)
  })

  it('a certified claim is Actual and not Claimed', () => {
    expect(row('cc4').actual).toBe(250)
    expect(row('cc4').claimed).toBe(0)
  })

  it('Committed is remaining open commitment: draft POs and invoiced amounts excluded', () => {
    expect(row('cc1').committed).toBe(200)       // 800 − 600 invoiced; draft PO 99999 ignored
    expect(row('cc2').committed).toBe(0)
  })

  it('cash is recorded cash only — never an invoice amount', () => {
    expect(fig(r, 'cash', 'cashIn').value).toBe(1100)     // posted receipt; draft 5000 ignored; issued invoice 3300 is not cash
    expect(fig(r, 'cash', 'cashOut').value).toBe(500)     // posted payment; draft ignored
    expect(fig(r, 'cash', 'netCash').value).toBe(600)
    expect(fig(r, 'cash', 'receivablesOutstanding').value).toBe(2200) // 3300 issued − 1100 received
    expect(fig(r, 'cash', 'remainingPayable').value).toBe(directSnapshot.remainingPayable.value)
  })
})

// ── 4. Variations: approved vs pending ───────────────────────────────────────

describe('variations — pending is never approved', () => {
  const r = build()

  it('approved and pending client variations are separate figures', () => {
    expect(fig(r, 'variations', 'approvedClientVariations').value).toBe(2000)
    expect(fig(r, 'variations', 'pendingClientVariations').value).toBe(900)
    // Only the approved one is in the contract sum.
    expect(fig(r, 'summary', 'currentContractSum').value).toBe(10000 + 2000)
  })

  it('pending supplier variations are not in Forecast Final Cost', () => {
    expect(fig(r, 'variations', 'pendingSupplierVariations').value).toBe(70)
    const withoutPending = build({ ...SOURCES, variations: variations.filter(v => v.id !== 'v4') })
    expect(fig(withoutPending, 'summary', 'forecastFinalCost').value).toBe(fig(r, 'summary', 'forecastFinalCost').value)
  })

  it('pending items are flagged for display and export', () => {
    const pending = r.variations.filter(v => v.pending).map(v => v.key)
    expect(pending).toEqual(['pendingClientVariations', 'pendingSupplierVariations'])
  })
})

// ── 5. Missing / failed / loading sources; genuine zero; empty project ───────

describe('availability', () => {
  it('every report source failing makes every figure Unavailable — nothing is zero', () => {
    const states = Object.fromEntries(REPORT_SOURCES.map(s => [s, { loading: false, error: true }]))
    const r = build(SOURCES, states)
    for (const item of [...r.summary, ...r.variations, ...r.cash]) {
      expect(item.figure.value, item.key).toBeNull()
      expect([FIGURE_STATE.UNAVAILABLE], item.key).toContain(item.figure.state)
    }
    expect(r.failedSources).toEqual(REPORT_SOURCES)
  })

  it('a missing state entry is treated as failed (never assumed successful)', () => {
    const states = settled()
    delete states.clientReceipts
    const r = build(SOURCES, states)
    expect(fig(r, 'cash', 'cashIn').state).toBe(FIGURE_STATE.UNAVAILABLE)
    expect(fig(r, 'cash', 'receivablesOutstanding').state).toBe(FIGURE_STATE.UNAVAILABLE)
    expect(fig(r, 'cash', 'cashOut').state).toBe(FIGURE_STATE.READY)
  })

  it('a failed claims read makes Claimed, Actual and the table Unavailable', () => {
    const r = build(SOURCES, settled({ progressClaims: { loading: false, error: true } }))
    expect(fig(r, 'summary', 'claimed').state).toBe(FIGURE_STATE.UNAVAILABLE)
    expect(fig(r, 'summary', 'actual').state).toBe(FIGURE_STATE.UNAVAILABLE)
    expect(r.costCodes.state).toBe(FIGURE_STATE.UNAVAILABLE)
    expect(r.costCodes.totals).toBeNull()
  })

  it('a failed variations read makes contract, FFC and variations Unavailable', () => {
    const r = build(SOURCES, settled({ variations: { loading: false, error: true } }))
    for (const k of ['currentContractSum', 'forecastFinalCost', 'forecastGrossProfit', 'forecastMarginPct']) {
      expect(fig(r, 'summary', k).state, k).toBe(FIGURE_STATE.UNAVAILABLE)
    }
    for (const v of r.variations) expect(v.figure.state, v.key).toBe(FIGURE_STATE.UNAVAILABLE)
  })

  it('loading renders as loading and the report is not exportable', () => {
    const r = build(SOURCES, settled({ supplierInvoices: { loading: true, error: false } }))
    expect(fig(r, 'summary', 'actual').state).toBe(FIGURE_STATE.LOADING)
    expect(fig(r, 'summary', 'actual').value).toBeNull()
    expect(r.loading).toBe(true)
    expect(isReportExportable(r)).toBe(false)
    expect(() => commercialReportCsv(r, { generatedAt: new Date() })).toThrow()
  })

  it('an empty, settled project reports genuine zeros and an empty table', () => {
    const empty = {
      budgetLines: [], approvedBudget: null, purchaseOrders: [], progressClaims: [], supplierInvoices: [],
      supplierCreditNotes: [], variations: [], forecastLines: [], baseline: { originalContractValue: 0 },
      supplierPayments: [], retentionReleases: [], clientInvoices: [], clientReceipts: [], costCodes: [],
    }
    const r = build(empty)
    expect(fig(r, 'summary', 'approvedBudget')).toMatchObject({ state: FIGURE_STATE.READY, value: 0 })
    expect(fig(r, 'summary', 'actual')).toMatchObject({ state: FIGURE_STATE.READY, value: 0 })
    expect(fig(r, 'cash', 'cashIn')).toMatchObject({ state: FIGURE_STATE.READY, value: 0 })
    // Margin % over zero revenue is not calculable — never 0%.
    expect(fig(r, 'summary', 'forecastMarginPct')).toMatchObject({ state: FIGURE_STATE.READY, value: null })
    expect(r.costCodes.state).toBe(FIGURE_STATE.READY)
    expect(r.costCodes.rows).toEqual([])
    expect(isReportExportable(r)).toBe(true)
  })

  it('no contract value → contract, revenue and margin are "not established", not zero', () => {
    const r = build({ ...SOURCES, baseline: null })
    expect(r.contractNotEstablished).toBe(true)
    for (const k of ['originalContractValue', 'currentContractSum', 'forecastRevenue', 'forecastGrossProfit', 'forecastMarginPct']) {
      expect(fig(r, 'summary', k), k).toMatchObject({ state: MARGIN_NOT_ESTABLISHED, value: null })
    }
    // Cost figures are unaffected.
    expect(fig(r, 'summary', 'forecastFinalCost').state).toBe(FIGURE_STATE.READY)
  })

  it('the report declares every snapshot source plus the four receivable-side sources', () => {
    // Phase 2 step 5 adds the two settlement registers (refunds, receipt applications).
    expect(REPORT_SOURCES).toEqual([...SNAPSHOT_SOURCES, 'clientInvoices', 'clientReceipts', 'clientCreditNotes', 'clientRetentionReleases', 'clientRefunds', 'clientReceiptApplications'])
    expect(REPORT_DEPENDENCIES.costCodeRows).toContain('progressClaims')
    // Net cash = receipts − refunds − payments.
    expect(REPORT_DEPENDENCIES.netCash).toEqual(['clientReceipts', 'clientRefunds', 'supplierPayments'])
  })
})

// ── 5b. Receivables: the ONE receivable contract (ADR-87 / ADR-88) ───────────
//
// CI-0001 is 3,000 ex-GST / 3,300 gross with 1,100 received (the base fixture's
// figures), here carrying its line so a credit note can credit it.

describe('receivables follow the one receivable contract', () => {
  const sourcesWith = ({ retention = 0, credit = null, release = null, creditOver = {}, releaseOver = {} } = {}) => {
    const invoice = issuedInvoice({ subtotal: 3000, retention, clientName: 'Owner' })
    return {
      ...SOURCES,
      clientInvoices: [invoice, clientInvoices[1]],
      clientCreditNotes: credit === null ? [] : [creditNoteFor(invoice, credit, creditOver)],
      clientRetentionReleases: release === null ? [] : [releaseFor(invoice, release, releaseOver)],
    }
  }
  const cash = (report, key) => fig(report, 'cash', key)
  const base = build()

  it('with no credit note and no retention every figure is the pre-existing one', () => {
    const r = build(sourcesWith())
    expect(cash(r, 'receivablesOutstanding').value).toBe(2200)
    expect(cash(r, 'clientRetentionHeld')).toEqual({ state: FIGURE_STATE.READY, failedSources: [], value: 0 })
    expect(cash(r, 'owedToClient')).toEqual({ state: FIGURE_STATE.READY, failedSources: [], value: 0 })
    expect(r.cash.map(i => i.key)).toEqual(['cashIn', 'cashOut', 'netCash', 'receivablesOutstanding', 'clientRetentionHeld', 'owedToClient', 'remainingPayable'])
  })

  it('a posted credit note reduces what is outstanding — and is not cash, revenue, cost or margin', () => {
    const r = build(sourcesWith({ credit: 500 }))                 // 550 gross
    expect(cash(r, 'receivablesOutstanding').value).toBe(1650)    // 3,300 − 550 − 1,100
    for (const key of ['cashIn', 'cashOut', 'netCash', 'remainingPayable']) expect(cash(r, key), key).toEqual(cash(base, key))
    expect(r.summary).toEqual(base.summary)                       // contract sum, forecast revenue, cost, profit, margin
    expect(r.variations).toEqual(base.variations)
    expect(r.costCodes).toEqual(base.costCodes)
  })

  it('a draft, void or gate-failing credit note reduces nothing', () => {
    for (const creditOver of [{ status: 'draft' }, { status: 'void' }, { clientId: 'someone-else' }]) {
      expect(cash(build(sourcesWith({ credit: 500, creditOver })), 'receivablesOutstanding').value, JSON.stringify(creditOver)).toBe(2200)
    }
  })

  it('client retention held is billed but not receivable until a posted release', () => {
    const held = build(sourcesWith({ retention: 300 }))           // 300 + 30 GST withheld
    expect(cash(held, 'clientRetentionHeld').value).toBe(330)
    expect(cash(held, 'receivablesOutstanding').value).toBe(1870) // 3,300 − 330 − 1,100
    const released = build(sourcesWith({ retention: 300, release: 100 }))
    expect(cash(released, 'clientRetentionHeld').value).toBe(220)
    expect(cash(released, 'receivablesOutstanding').value).toBe(1980)
    // A release is not cash.
    expect(cash(released, 'cashIn')).toEqual(cash(base, 'cashIn'))
    expect(cash(released, 'netCash')).toEqual(cash(base, 'netCash'))
    expect(cash(build(sourcesWith({ retention: 300, release: 100, releaseOver: { status: 'draft' } })), 'clientRetentionHeld').value).toBe(330)
  })

  it('a credit after receipt is OWED TO THE CLIENT — shown, never clamped, never netted into outstanding', () => {
    const r = build(sourcesWith({ credit: 2500 }))                // 2,750 gross → 550 receivable, 1,100 received
    expect(cash(r, 'owedToClient').value).toBe(550)
    expect(cash(r, 'receivablesOutstanding').value).toBe(0)
    expect(cash(r, 'cashIn').value).toBe(1100)
  })

  it('the three figures are receivablesSummary over the contract\'s positions — no arithmetic of the report\'s own', () => {
    const s = sourcesWith({ retention: 300, credit: 500, release: 100 })
    const { positions } = receivableContext(s.clientInvoices, s.clientCreditNotes, s.clientRetentionReleases)
    const summary = receivablesSummary(s.clientInvoices, s.clientReceipts, positions)
    const r = build(s)
    expect(cash(r, 'receivablesOutstanding').value).toBe(summary.remaining)
    expect(cash(r, 'clientRetentionHeld').value).toBe(summary.retentionHeld)
    expect(cash(r, 'owedToClient').value).toBe(summary.owedToClient)
    const code = stripComments(read('lib/commercialReport.js'))
    expect(code).toContain('receivableContext(clientInvoices, clientCreditNotes, clientRetentionReleases)')
    // Phase 2 step 5: the same selector, given the settlement registers.
    expect(code).toContain('receivablesSummary(clientInvoices, clientReceipts, positions, settlement)')
  })

  it('a FAILED credit-note read makes the receivable figures Unavailable — never the figure "no credits" would give', () => {
    const s = { ...sourcesWith({ credit: 500 }), clientCreditNotes: [] }   // what a failed listener hands over
    const r = build(s, settled({ clientCreditNotes: { loading: false, error: true } }))
    for (const key of ['receivablesOutstanding', 'clientRetentionHeld', 'owedToClient']) {
      expect(cash(r, key), key).toEqual({ state: FIGURE_STATE.UNAVAILABLE, failedSources: ['clientCreditNotes'], value: null })
    }
    // Cash and every cost / contract figure do not read credit notes.
    expect(cash(r, 'cashIn').value).toBe(1100)
    expect(cash(r, 'netCash').value).toBe(600)
    expect(fig(r, 'summary', 'currentContractSum').state).toBe(FIGURE_STATE.READY)
    expect(r.failedSources).toEqual(['clientCreditNotes'])
    const csv = commercialReportCsv(r, { generatedAt: new Date(2026, 10, 26, 9, 0) })
    expect(csv).toContain('"Cash","Client invoices outstanding","UNAVAILABLE","AUD","Could not load: Client Credit Notes"')
    expect(csv).toContain('"Cash","Owed to client","UNAVAILABLE","AUD","Could not load: Client Credit Notes"')
  })

  it('a FAILED release read does the same; a LOADING one is loading; a missing state entry is a failure', () => {
    const failed = build(sourcesWith({ retention: 300 }), settled({ clientRetentionReleases: { loading: false, error: true } }))
    for (const key of ['receivablesOutstanding', 'clientRetentionHeld', 'owedToClient']) {
      expect(cash(failed, key), key).toEqual({ state: FIGURE_STATE.UNAVAILABLE, failedSources: ['clientRetentionReleases'], value: null })
    }
    const loading = build(sourcesWith(), settled({ clientCreditNotes: { loading: true, error: false } }))
    expect(cash(loading, 'receivablesOutstanding')).toEqual({ state: FIGURE_STATE.LOADING, failedSources: [], value: null })
    expect(isReportExportable(loading)).toBe(false)
    const states = settled()
    delete states.clientRetentionReleases
    expect(cash(build(sourcesWith(), states), 'clientRetentionHeld').state).toBe(FIGURE_STATE.UNAVAILABLE)
  })

  it('dependencies: cash reads receipts and payments only; receivables read all four registers; held retention reads no receipt', () => {
    // Phase 2 step 5: cash in is net of refunds; what an invoice holds counts applications and refunds.
    expect(REPORT_DEPENDENCIES.cashIn).toEqual(['clientReceipts', 'clientRefunds'])
    expect(REPORT_DEPENDENCIES.receivables).toEqual(['clientInvoices', 'clientReceipts', 'clientCreditNotes', 'clientRetentionReleases', 'clientRefunds', 'clientReceiptApplications'])
    expect(REPORT_DEPENDENCIES.clientRetentionHeld).toEqual(['clientInvoices', 'clientCreditNotes', 'clientRetentionReleases'])
  })

  it('the export carries both new figures, gross, in the Cash section', () => {
    const csv = commercialReportCsv(build(sourcesWith({ retention: 300, credit: 2500 })), { generatedAt: new Date(2026, 10, 26, 9, 0) })
    expect(csv).toMatch(/"Cash","Client retention held",\d+\.\d\d,"AUD","Client retention held — billed, not receivable until released, gross"/)
    expect(csv).toMatch(/"Cash","Owed to client",\d+\.\d\d,"AUD","Received beyond what is now receivable/)
  })
})

// ── 6. Project / currency isolation; deterministic order ─────────────────────

describe('isolation and ordering', () => {
  it('one project in one currency: the currency is carried, never converted', () => {
    const aud = build(SOURCES, settled(), 'AUD')
    const nzd = build(SOURCES, settled(), 'NZD')
    expect(nzd.currencyCode).toBe('NZD')
    expect(fig(nzd, 'summary', 'actual').value).toBe(fig(aud, 'summary', 'actual').value)
    const csv = commercialReportCsv(nzd, { generatedAt: new Date(2026, 10, 18) })
    expect(csv).toContain('"Currency","NZD"')
    expect(csv).toContain('Actual cost (NZD)')
    expect(csv).not.toContain('(AUD)')
  })

  it('the report carries exactly the project it was given and no portfolio API exists', async () => {
    const r = build()
    expect(r.projectId).toBe('p1')
    expect(r.projectName).toBe('Gold Coast Apartments')
    const mod = await import('../../src/lib/commercialReport')
    expect(Object.keys(mod).some(k => /portfolio|allProjects/i.test(k))).toBe(false)
  })

  it('rows are in a deterministic, locale-pinned order with an id tie-break', () => {
    const r = build()
    const names = r.costCodes.rows.map(x => x.costCodeName)
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, 'en')))
    const a = { costCodeName: 'Same', costCodeId: 'b' }
    const b = { costCodeName: 'Same', costCodeId: 'a' }
    expect([a, b].sort(compareReportRows).map(x => x.costCodeId)).toEqual(['a', 'b'])
    // Same input → byte-identical CSV.
    const at = new Date(Date.UTC(2026, 10, 18, 1, 2, 3))
    expect(commercialReportCsv(build(), { generatedAt: at })).toBe(commercialReportCsv(build(), { generatedAt: at }))
  })
})

// ── 7. CSV escaping and formula-injection safety ─────────────────────────────

describe('CSV utility', () => {
  const NBSP = String.fromCharCode(0xA0)
  const ZWSP = String.fromCharCode(0x200B)
  const RLO = String.fromCharCode(0x202E)
  const BOM = String.fromCharCode(0xFEFF)
  const FW_EQ = String.fromCharCode(0xFF1D)
  const NUL = String.fromCharCode(0)
  const BEL = String.fromCharCode(7)

  it('quotes every text cell and doubles embedded quotes', () => {
    expect(csvCell('plain')).toBe('"plain"')
    expect(csvCell('a,b')).toBe('"a,b"')
    expect(csvCell('say "hi"')).toBe('"say ""hi"""')
    expect(csvCell('line1\r\nline2')).toBe('"line1\nline2"')
    expect(csvCell(null)).toBe('""')
  })

  it.each([
    ['=1+1'], ['+SUM(A1)'], ['-2+3'], ['@SUM(A1)'],
    ['  =cmd'], ['\n=cmd'], [`${NBSP}=cmd`], [`${ZWSP}=cmd`], [`${RLO}=cmd`], [`${BOM}=cmd`],
    [`${FW_EQ}cmd`], ['\t=cmd'], ['\tplain'], ['\r=cmd'],
  ])('neutralises a formula trigger: %j', (input) => {
    expect(isFormulaLike(input)).toBe(true)
    expect(sanitizeCsvText(input).startsWith("'")).toBe(true)
    expect(csvCell(input).startsWith(`"'`)).toBe(true)
  })

  it('a control character cannot hide a trigger, and is removed', () => {
    expect(sanitizeCsvText(`${NUL}=cmd`)).toBe("'=cmd")
    expect(sanitizeCsvText(`${BEL}@x`)).toBe("'@x")
    expect(sanitizeCsvText(`a${NUL}b`)).toBe('ab')
  })

  it('leaves ordinary text alone (including inner = + - @)', () => {
    expect(sanitizeCsvText('03-100 — Concrete')).toBe('03-100 — Concrete')
    expect(sanitizeCsvText('a=b')).toBe('a=b')
    expect(sanitizeCsvText('user@example')).toBe('user@example')
  })

  it('numbers stay numbers — a negative amount is not treated as a formula', () => {
    expect(csvCell(-1234.5)).toBe('-1234.5')
    expect(csvRows([[csvMoney(-1234.5), csvMoney(0), csvMoney(-0)]])).toBe('-1234.50,0.00,0.00\r\n')
    expect(csvMoney(NaN)).toBeNull()
    expect(csvCell(Infinity)).toBe('""')
  })

  it('a text cell that looks like a negative number is still neutralised', () => {
    expect(csvCell('-1234')).toBe(`"'-1234"`)
  })

  it('CRLF line endings with a trailing CRLF', () => {
    expect(csvRows([['a', 'b'], ['c']])).toBe('"a","b"\r\n"c"\r\n')
  })

  it('filename slugs are safe and never empty', () => {
    expect(filenameSlug('Gold Coast Apartments')).toBe('gold-coast-apartments')
    expect(filenameSlug('../../etc/passwd')).toBe('etc-passwd')
    expect(filenameSlug('Café Ñandú')).toBe('cafe-nandu')
    expect(filenameSlug('=HYPERLINK()')).toBe('hyperlink')
    expect(filenameSlug('!!!', 'project')).toBe('project')
    expect(filenameSlug('x'.repeat(200)).length).toBe(60)
  })
})

// ── 8. Export behaviour ──────────────────────────────────────────────────────

describe('commercial report CSV export', () => {
  const at = new Date(2026, 10, 18, 9, 30)
  const csv = commercialReportCsv(build(), { generatedAt: at })
  const lines = csv.split('\r\n')

  it('has a project header, currency, labelled generation time and budget source', () => {
    expect(lines[0]).toBe('"Constrap Commercial Report"')
    expect(lines[1]).toBe('"Project","Gold Coast Apartments"')
    expect(lines[2]).toBe('"Currency","AUD"')
    expect(lines[3]).toContain(`"Generated","${at.toISOString()}"`)
    expect(lines[3]).toContain('Not an accounting cut-off')
    expect(lines[4]).toBe('"Budget source","Working budget (not approved)"')
  })

  it('writes money as 2-decimal numbers and the margin as a percentage number', () => {
    expect(csv).toContain('"Summary","Actual Cost",1150.00,"AUD"')
    expect(csv).toContain('"Summary","Forecast Margin",87.50,"%"')
    expect(csv).toContain('"Summary","Variance to Budget",100.00,"AUD"')
  })

  it('marks pending variations explicitly', () => {
    expect(csv).toMatch(/"Variations","Pending client variations",900\.00,"AUD","PENDING — not approved; /)
  })

  it('cost-code rows: explicit NO BUDGET LINE, totals equal the summary', () => {
    expect(csv).toContain('"04-100 — Masonry","NO BUDGET LINE",0.00,0.00,250.00,250.00,0.00,"NO BUDGET LINE"')
    expect(csv).toContain('"Total",1600.00,200.00,195.00,1150.00,1500.00,350.00,100.00')
  })

  it('explicit unavailable / not-set values — never blank, never zero', () => {
    const failed = commercialReportCsv(
      build(SOURCES, settled({ clientReceipts: { loading: false, error: true } })), { generatedAt: at },
    )
    expect(failed).toContain('"Cash","Cash received (client receipts)","UNAVAILABLE","AUD","Could not load: Client Receipts"')
    const notSet = commercialReportCsv(build({ ...SOURCES, baseline: null }), { generatedAt: at })
    expect(notSet).toContain('"Summary","Current Contract Sum","NOT SET","AUD"')
    const tableFailed = commercialReportCsv(
      build(SOURCES, settled({ forecastLines: { loading: false, error: true } })), { generatedAt: at },
    )
    expect(tableFailed).toContain('"UNAVAILABLE","Could not load: Forecast Lines"')
  })

  it('figureCsvValue covers every state', () => {
    expect(figureCsvValue({ state: FIGURE_STATE.READY, value: 0 })).toEqual({ csvNumber: '0.00' })
    expect(figureCsvValue({ state: FIGURE_STATE.UNAVAILABLE, value: null })).toBe(CSV_MARKER.UNAVAILABLE)
    expect(figureCsvValue({ state: MARGIN_NOT_ESTABLISHED, value: null })).toBe(CSV_MARKER.NOT_SET)
    expect(figureCsvValue({ state: FIGURE_STATE.READY, value: null }, FIGURE_KIND.PERCENT)).toBe('NOT CALCULABLE')
    expect(figureCsvValue(undefined)).toBe(CSV_MARKER.UNAVAILABLE)
  })

  it('a hostile project or cost-code name is neutralised in the export', () => {
    const hostile = commercialReportCsv(
      build({ ...SOURCES, costCodes: [{ id: 'cc1', code: '=HYPERLINK("x")', name: 'evil' }] }, settled(), 'AUD',
        { id: 'p1', name: '@SUM(1)' }),
      { generatedAt: at },
    )
    expect(hostile).toContain(`"Project","'@SUM(1)"`)
    expect(hostile).toContain(`"'=HYPERLINK(""x"") — evil"`)
  })

  it('exports only report-model content — no raw record fields', () => {
    for (const leaked of ['Ace Concrete', 'INV-100', 'SI-0001', 'Owner', 'CR-0001', 'Over-claimed']) {
      expect(csv).not.toContain(leaked)
    }
  })

  it('refuses without a valid generation time', () => {
    expect(() => commercialReportCsv(build(), {})).toThrow()
    expect(() => commercialReportCsv(build(), { generatedAt: new Date('x') })).toThrow()
  })

  it('filename is project-based and dated in local time', () => {
    expect(localDateKey(at)).toBe('2026-11-18')
    expect(commercialReportFilename(build(), at)).toBe('constrap-commercial-report-gold-coast-apartments-2026-11-18.csv')
    expect(commercialReportFilename({ projectName: '', projectId: 'AbC123' }, at)).toBe('constrap-commercial-report-abc123-2026-11-18.csv')
  })
})

// ── 9. Role, route, read-only and print structure ────────────────────────────

describe('page structure', () => {
  const page = read('pages/project/ProjectReports.jsx')
  const code = stripComments(page)
  const app = read('App.jsx')
  const tabs = read('lib/projectTabs.js')
  const css = read('index.css')

  it('the reports route renders the report, not the placeholder', () => {
    expect(app).toMatch(/<Route path="reports" element=\{<ProjectReports \/>\} \/>/)
    expect(app).toContain("import ProjectReports from './pages/project/ProjectReports'")
  })

  it('Reports is a project tab', () => {
    expect(tabs).toMatch(/to:\s*'reports',\s*label:\s*'Reports'/)
  })

  it('the role gate precedes every subscription: the report body mounts only for financial roles', () => {
    expect(code).toMatch(/if \(!isFinancialRole\(profile\?\.role\)\)/)
    const outer = code.slice(code.indexOf('export default function ProjectReports'))
    expect(outer).not.toMatch(/use(BudgetLines|PurchaseOrders|ProgressClaims|SupplierInvoices|ClientReceipts|CostCodes)\(/)
    expect(outer).toContain('<CommercialReport')
  })

  it('is read-only: no Firestore write API and no hook write callback', () => {
    for (const f of ['pages/project/ProjectReports.jsx', 'lib/commercialReport.js', 'lib/commercialReportCsv.js', 'lib/csv.js']) {
      const src = stripComments(read(f))
      expect(src, f).not.toMatch(/firebase\/firestore|addDoc|setDoc|updateDoc|deleteDoc|writeBatch|runTransaction/)
      expect(src, f).not.toMatch(/\b(create|update|delete|post|approve|withdraw|void)[A-Z]\w*\s*[,}]/)
    }
    // The only side effect is a browser file save of the generated CSV.
    expect(stripComments(read('pages/project/ProjectReports.jsx'))).toMatch(/import \{ saveBlob \} from '..\/..\/lib\/fileBlob'/)
  })

  it('the page does no money arithmetic of its own (figures come from the report model)', () => {
    expect(code).not.toMatch(/projectForecastTotals|forecastRollups|computeMargin|claimedPendingByCostCode|totalActualCash/)
    expect(code).not.toMatch(/\.value\s*[-+*/]\s*|[-+*/]\s*\w+\.value\b/)
  })

  it('loading, failed and not-set states are rendered distinctly', () => {
    expect(code).toContain("return '—'")
    expect(code).toContain("return 'Unavailable'")
    expect(code).toContain("return 'Not set'")
  })

  it('the table is accessible: caption, column and row headers', () => {
    expect(code).toContain('<caption')
    expect(code).toContain('scope="col"')
    expect(code).toContain('scope="row"')
    expect(code).toMatch(/<div className="overflow-x-auto report-table-wrap">\s*<table/)
  })

  it('print rules are scoped to the report and hide chrome and controls', () => {
    const block = css.slice(css.indexOf('L2-A Commercial Report — print'))
    expect(block).toMatch(/@media print/)
    const selectors = block.match(/^[^{}@]+\{/gm).map(s => s.trim()).filter(s => !s.startsWith('/*'))
    for (const s of selectors) expect(s, s).toMatch(/commercial-report/)
    expect(block).toContain('[data-print-hide]')
    expect(block).toContain('.report-controls')
    expect(block).toMatch(/break-inside:\s*avoid/)
    // The landscape page setup is a NAMED page used only by the report.
    expect(block).toMatch(/@page commercial-report \{/)
    expect(block).not.toMatch(/@page\s*\{/)
    expect(code).toContain('report-controls')
  })

  it('the app shell and project layout carry the print hooks', () => {
    expect(read('layouts/AppShell.jsx')).toMatch(/data-app-shell[\s\S]*data-app-content[\s\S]*data-app-main/)
    expect((read('layouts/ProjectDetailLayout.jsx').match(/data-print-hide/g) || []).length).toBe(2)
  })
})
