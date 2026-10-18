import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  evaluatePulse, summarisePulse, groupIndicators,
  PULSE_STATE, PULSE_STATE_ORDER, INDICATOR, INDICATOR_ORDER, INDICATOR_DEPENDENCIES,
  INDICATOR_LINKS, PULSE_SOURCES, PULSE_SOURCE_LABELS, NEEDS_DATA_REASON,
} from '../../src/lib/pulse'
import {
  projectForecastRows, projectForecastTotals, computeMargin, FINANCIAL_ROLES,
} from '../../src/lib/margin'
import { buildForecastRows, composeForecastRow, forecastRollups } from '../../src/lib/forecast'
import { projectSnapshot, FIGURE_STATE, SNAPSHOT_SOURCES } from '../../src/lib/projectSnapshot'
import { payablesSummary, apAgeing, paymentSummary } from '../../src/lib/supplierPayments'
import { releasedByInvoiceId } from '../../src/lib/retention'
import {
  pendingSupplierVariationExposureTotal, pendingClientVariationExposureTotal,
} from '../../src/lib/variations'
import { timelineSummary, PROGRAMME_READ_ROLES } from '../../src/lib/projectTimeline'
import { PROJECT_TABS } from '../../src/lib/projectTabs'
import { formatCurrency } from '../../src/lib/formatters'

// ── Constrapp PULSE™ 1A (ADR-47) ─────────────────────────────────────────────
//
// PULSE is a read-only composition of existing selectors. These tests pin:
//
//   1. every indicator's five states — loading, unavailable, needs data,
//      finding, no issue — and that a loading, failed or MISSING source can
//      never yield "no issue";
//   2. the dependency map, VERIFIED BY PERTURBATION against the real selectors
//      (every declared source moves the indicator; no undeclared source does);
//   3. financial consistency — PULSE figures ARE projectForecastTotals /
//      computeMargin / payablesSummary / apAgeing outputs for the same fixture,
//      and the Dashboard snapshot is unchanged;
//   4. the Phase-3 extraction: projectForecastRows is the one composition
//      projectForecastTotals rolls up;
//   5. the domain rules: a saved 0 is a forecast, cent-boundary comparisons,
//      settled / credited / retained / unallocated payables, closed activities,
//      draft vs submitted exposure with no double counting;
//   6. page wiring and roles, as SOURCE STRUCTURE (no DOM runner — ADR-26).

const read = (rel) =>
  readFileSync(fileURLToPath(new URL(`../../src/${rel}`, import.meta.url)), 'utf8')
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '')

// ── Fixture ──────────────────────────────────────────────────────────────────
//
// Built so that EVERY source moves at least one indicator, and so that the
// six indicators land on a mix of states. "Today" is fixed.
const NOW = new Date(2026, 2, 15) // 15 March 2026, local

const inv1 = {
  id: 'inv1', invoiceNumber: 'SI-0001', supplierInvoiceNumber: 'INV-100',
  status: 'posted', supplierId: 'sup1', supplierName: 'Ace Concrete', currency: 'AUD', poId: 'po1',
  lineItems: [
    { poLineIndex: 0, costCodeId: 'cc1', costCodeName: '03-100 — Concrete', description: 'Slab', amount: 600, taxCode: 'gst', gstAmount: 60 },
    { poLineIndex: 1, costCodeId: 'cc2', costCodeName: '03-200 — Formwork', description: 'Forms', amount: 400, taxCode: 'gst', gstAmount: 40 },
  ],
  retention: 0, retentionGst: 0, retentionTotal: 0,
  subtotal: 1000, gstTotal: 100, grossTotal: 1100, net: 1000, payableGst: 100, payableTotal: 1100,
  dueDate: '2026-01-31', // past due; partly paid and partly credited below
}
// Retained invoice: payable basis excludes retention held; a posted release adds it back.
const inv2 = {
  id: 'inv2', invoiceNumber: 'SI-0002', supplierInvoiceNumber: 'INV-200',
  status: 'posted', supplierId: 'sup2', supplierName: 'Beta Steel', currency: 'AUD', poId: 'po1',
  lineItems: [{ poLineIndex: 0, costCodeId: 'cc1', costCodeName: '03-100 — Concrete', description: 'Rebar', amount: 2000, taxCode: 'gst', gstAmount: 200 }],
  retention: 100, retentionGst: 10, retentionTotal: 110,
  subtotal: 2000, gstTotal: 200, grossTotal: 2200, net: 1900, payableGst: 190, payableTotal: 2090,
  dueDate: '2026-02-28', // past due; nothing paid
}
// Fully settled past its due date — must NOT be flagged.
const inv3 = {
  id: 'inv3', invoiceNumber: 'SI-0003', supplierInvoiceNumber: 'INV-300',
  status: 'posted', supplierId: 'sup1', supplierName: 'Ace Concrete', currency: 'AUD', poId: 'po1',
  lineItems: [{ poLineIndex: 1, costCodeId: 'cc2', costCodeName: '03-200 — Formwork', description: 'Extra forms', amount: 300, taxCode: 'gst', gstAmount: 30 }],
  retention: 0, retentionGst: 0, retentionTotal: 0,
  subtotal: 300, gstTotal: 30, grossTotal: 330, net: 300, payableGst: 30, payableTotal: 330,
  dueDate: '2026-01-15',
}
// Not yet due.
const inv4 = {
  id: 'inv4', invoiceNumber: 'SI-0004', supplierInvoiceNumber: 'INV-400',
  status: 'posted', supplierId: 'sup2', supplierName: 'Beta Steel', currency: 'AUD', poId: 'po1',
  lineItems: [{ poLineIndex: 0, costCodeId: 'cc1', costCodeName: '03-100 — Concrete', description: 'Mesh', amount: 500, taxCode: 'gst', gstAmount: 50 }],
  retention: 0, retentionGst: 0, retentionTotal: 0,
  subtotal: 500, gstTotal: 50, grossTotal: 550, net: 500, payableGst: 50, payableTotal: 550,
  dueDate: '2026-04-30',
}
// Draft — never payable, never aged.
const inv5 = { ...inv4, id: 'inv5', invoiceNumber: 'SI-0005', status: 'draft', dueDate: '2025-01-01' }

const SOURCES = {
  budgetLines: [
    { id: 'bl1', costCodeId: 'cc1', budgeted: 1000 },
    { id: 'bl2', costCodeId: 'cc2', budgeted: 500 },
    { id: 'bl5', costCodeId: 'cc5', budgeted: 300 },
  ],
  purchaseOrders: [
    { id: 'po1', status: 'sent', lineItems: [
      { costCodeId: 'cc1', lineTotal: 800 },
      { costCodeId: 'cc2', lineTotal: 400 },
    ] },
    { id: 'po3', status: 'sent', lineItems: [{ costCodeId: 'cc6', lineTotal: 90 }] },
  ],
  progressClaims: [
    { id: 'cl1', status: 'approved', poId: 'po2', lineItems: [{ costCodeId: 'cc4', approvedThisPeriod: 250 }] },
  ],
  supplierInvoices: [inv1, inv2, inv3, inv4, inv5],
  supplierCreditNotes: [{
    id: 'cn1', creditNumber: 'SCN-0001', status: 'posted', docType: 'credit_note',
    supplierInvoiceId: 'inv1', invoiceNumber: 'SI-0001', supplierInvoiceNumber: 'INV-100',
    supplierId: 'sup1', supplierName: 'Ace Concrete', supplierCreditReference: 'CN-9',
    creditDate: '2026-02-01', reason: 'Over-claimed quantities',
    // Credits the UNFORECAST cost code (cc2), so the credit visibly moves the
    // incomplete indicator's evidence (its Actual) as well as the cost figures.
    lineItems: [{ costCodeId: 'cc2', costCodeName: '03-200 — Formwork', description: 'Credit', amount: 100, taxCode: 'gst', gstAmount: 10 }],
    subtotal: 100, gstTotal: 10, grossTotal: 110, currency: 'AUD',
  }],
  variations: [
    { id: 'v1', variationNumber: 'CV-0001', title: 'Extra level', variationType: 'client', status: 'approved', approvedSubtotal: 2000, lineItems: [] },
    { id: 'v2', variationNumber: 'CV-0002', title: 'Lift upgrade', variationType: 'client', status: 'submitted', submittedSubtotal: 300, clientName: 'Owner Co', lineItems: [] },
    { id: 'v3', variationNumber: 'SV-0001', title: 'Rock', variationType: 'supplier', status: 'approved', approvedSubtotal: 50,
      lineItems: [{ costCodeId: 'cc7', approvedAmount: 50 }] },
    { id: 'v4', variationNumber: 'SV-0002', title: 'Pump hire', variationType: 'supplier', status: 'submitted', submittedSubtotal: 70, supplierName: 'Ace Concrete',
      lineItems: [{ costCodeId: 'cc2', submittedAmount: 70 }] },
    { id: 'v5', variationNumber: 'SV-0003', title: 'Night shift', variationType: 'supplier', status: 'draft', submittedSubtotal: 25, supplierName: 'Beta Steel',
      lineItems: [{ costCodeId: 'cc1', submittedAmount: 25 }] },
    { id: 'v6', variationNumber: 'CV-0003', title: 'Rejected', variationType: 'client', status: 'rejected', submittedSubtotal: 999, lineItems: [] },
  ],
  forecastLines: [
    { id: 'cc1', costCodeId: 'cc1', uncommittedCostToComplete: 150 },
    { id: 'cc2', costCodeId: 'cc2', uncommittedCostToComplete: null }, // NOT forecast
    { id: 'cc8', costCodeId: 'cc8', uncommittedCostToComplete: 40 },
  ],
  baseline: { originalContractValue: 10000, originalApprovedBudget: 1500 },
  supplierPayments: [
    { id: 'sp1', status: 'posted', amount: 700, allocatedTotal: 500, unallocatedAmount: 200,
      allocations: [{ supplierInvoiceId: 'inv1', allocatedAmount: 500 }] },
    { id: 'sp2', status: 'posted', amount: 330, allocatedTotal: 330, unallocatedAmount: 0,
      allocations: [{ supplierInvoiceId: 'inv3', allocatedAmount: 330 }] },
    { id: 'sp3', status: 'draft', amount: 9999, allocatedTotal: 9999, unallocatedAmount: 0,
      allocations: [{ supplierInvoiceId: 'inv2', allocatedAmount: 9999 }] }, // draft: moves nothing
  ],
  retentionReleases: [
    { id: 'rr1', status: 'posted', supplierInvoiceId: 'inv2', amount: 50, gstAmount: 5, releaseTotal: 55 },
    { id: 'rr2', status: 'draft',  supplierInvoiceId: 'inv2', amount: 50, gstAmount: 5, releaseTotal: 55 }, // draft: not released
  ],
  activities: [
    { id: 'a1', name: 'Excavate',   status: 'in_progress', isMilestone: false, plannedStart: '2026-02-01', plannedFinish: '2026-03-01', responsibleName: 'J. Smith', costCodeName: '02-100 — Earthworks' },
    { id: 'a2', name: 'Slab pour',  status: 'not_started', isMilestone: false, plannedStart: '2026-03-01', plannedFinish: '2026-03-14' },
    { id: 'a3', name: 'Frame',      status: 'not_started', isMilestone: false, plannedStart: '2026-03-10', plannedFinish: '2026-03-15' }, // due today: not overdue
    { id: 'a4', name: 'Lock-up',    status: 'completed',   isMilestone: true,  plannedStart: '2026-01-01', plannedFinish: '2026-01-01', actualFinish: '2026-01-02' },
    { id: 'a5', name: 'Old scope',  status: 'cancelled',   isMilestone: false, plannedStart: '2026-01-01', plannedFinish: '2026-01-10' },
    { id: 'a6', name: 'Handover',   status: 'not_started', isMilestone: true,  plannedStart: '2026-06-30', plannedFinish: '2026-06-30' },
  ],
}

const settled = (loading = false, error = false) => ({ loading, error })
const allSettled = () => Object.fromEntries(PULSE_SOURCES.map(s => [s, settled()]))
const withState = (overrides) => ({ ...allSettled(), ...overrides })

const run = (sources = SOURCES, sourceStates = allSettled(), now = NOW) =>
  evaluatePulse({ sources, sourceStates, now, currencyCode: 'AUD' })
const byId = (result) => Object.fromEntries(result.indicators.map(i => [i.id, i]))
const get = (id, sources, sourceStates, now) => byId(run(sources, sourceStates, now))[id]

const emptied = (source) => ({ ...SOURCES, [source]: source === 'baseline' ? null : [] })

// ── 0 · Shape ────────────────────────────────────────────────────────────────

describe('evaluatePulse — shape', () => {
  const result = run()

  it('returns the six indicators in the fixed order, each with the contract fields', () => {
    expect(result.indicators.map(i => i.id)).toEqual(INDICATOR_ORDER)
    for (const ind of result.indicators) {
      for (const k of ['id', 'title', 'link', 'state', 'failedSources', 'reason', 'headline', 'explanation', 'values', 'evidence', 'evidenceColumns', 'caveats']) {
        expect(ind, `${ind.id}.${k}`).toHaveProperty(k)
      }
      expect(Object.values(PULSE_STATE)).toContain(ind.state)
      expect(ind.link).toEqual(expect.objectContaining({ to: expect.any(String), label: expect.any(String) }))
    }
  })

  it('carries the project currency through unchanged', () => {
    expect(result.currencyCode).toBe('AUD')
    expect(run(SOURCES, allSettled(), NOW).currencyCode).toBe('AUD')
    expect(evaluatePulse({ sources: SOURCES, sourceStates: allSettled(), now: NOW, currencyCode: 'NZD' }).currencyCode).toBe('NZD')
  })

  it('the fixture lands the indicators on a mix of states (no trivial pass)', () => {
    const states = byId(result)
    expect(states[INDICATOR.FORECAST_OVER_BUDGET].state).toBe(PULSE_STATE.FINDING)
    expect(states[INDICATOR.FORECAST_INCOMPLETE].state).toBe(PULSE_STATE.FINDING)
    expect(states[INDICATOR.NEGATIVE_GROSS_PROFIT].state).toBe(PULSE_STATE.NEEDS_DATA)
    expect(states[INDICATOR.OVERDUE_ACTIVITIES].state).toBe(PULSE_STATE.FINDING)
    expect(states[INDICATOR.PAST_DUE_SUPPLIER_INVOICES].state).toBe(PULSE_STATE.FINDING)
    expect(states[INDICATOR.PENDING_VARIATION_EXPOSURE].state).toBe(PULSE_STATE.FINDING)
  })

  it('summary is counts by state that sum to six — and nothing else', () => {
    expect(Object.keys(result.summary.counts).sort()).toEqual([...PULSE_STATE_ORDER].sort())
    expect(Object.values(result.summary.counts).reduce((a, b) => a + b, 0)).toBe(6)
    expect(result.summary.total).toBe(6)
    expect(Object.keys(result.summary)).toEqual(['counts', 'total'])
    expect(summarisePulse(null).total).toBe(0)
  })

  it('groupIndicators partitions by state, preserving indicator order', () => {
    const g = groupIndicators(result.indicators)
    const flat = PULSE_STATE_ORDER.flatMap(s => g[s].map(i => i.id))
    expect(flat.sort()).toEqual([...INDICATOR_ORDER].sort())
    for (const s of PULSE_STATE_ORDER) for (const i of g[s]) expect(i.state).toBe(s)
    const findings = g[PULSE_STATE.FINDING].map(i => i.id)
    expect(findings).toEqual(INDICATOR_ORDER.filter(id => findings.includes(id)))
  })

  it('every link targets an existing project tab (tab-level — no invented URL filters)', () => {
    const tabs = PROJECT_TABS.map(t => t.to)
    for (const [id, link] of Object.entries(INDICATOR_LINKS)) {
      expect(tabs, id).toContain(link.to.split('/')[0])
      expect(link.to, id).not.toContain('?')
    }
    for (const ind of result.indicators) {
      expect(tabs).toContain(ind.link.to.split('/')[0])
      expect(ind.link.to).not.toContain('?')
    }
  })

  it('PULSE sources are the snapshot sources plus activities, all labelled', () => {
    expect(PULSE_SOURCES).toEqual([...SNAPSHOT_SOURCES, 'activities'])
    for (const s of PULSE_SOURCES) expect(PULSE_SOURCE_LABELS[s], s).toEqual(expect.any(String))
  })
})

// ── 1 · Availability: loading / failed / missing never become "no issue" ─────

describe('availability — a loading, failed or missing dependency never yields no issue', () => {
  for (const id of INDICATOR_ORDER) {
    for (const dep of INDICATOR_DEPENDENCIES[id]) {
      it(`${id}: ${dep} loading → LOADING, no evidence, no values`, () => {
        const ind = get(id, SOURCES, withState({ [dep]: settled(true, false) }))
        expect(ind.state).toBe(PULSE_STATE.LOADING)
        expect(ind.evidence).toEqual([])
        expect(ind.values).toEqual({})
      })
      it(`${id}: ${dep} failed → UNAVAILABLE naming it`, () => {
        const ind = get(id, SOURCES, withState({ [dep]: settled(false, true) }))
        expect(ind.state).toBe(PULSE_STATE.UNAVAILABLE)
        expect(ind.failedSources).toEqual([dep])
        expect(ind.evidence).toEqual([])
      })
      it(`${id}: ${dep} MISSING from sourceStates → UNAVAILABLE (missing is never success)`, () => {
        const states = allSettled()
        delete states[dep]
        const ind = get(id, SOURCES, states)
        expect(ind.state).toBe(PULSE_STATE.UNAVAILABLE)
        expect(ind.failedSources).toEqual([dep])
      })
    }
  }

  it('a failure outranks loading, and names only the failed sources', () => {
    const ind = get(INDICATOR.FORECAST_OVER_BUDGET, SOURCES, withState({
      budgetLines: settled(true, false), forecastLines: settled(false, true),
    }))
    expect(ind.state).toBe(PULSE_STATE.UNAVAILABLE)
    expect(ind.failedSources).toEqual(['forecastLines'])
  })

  it('with every source failed, no indicator is "no issue" and none is a finding', () => {
    const states = Object.fromEntries(PULSE_SOURCES.map(s => [s, settled(false, true)]))
    for (const ind of run(SOURCES, states).indicators) expect(ind.state).toBe(PULSE_STATE.UNAVAILABLE)
  })

  it('with an EMPTY sourceStates object, every indicator is unavailable (never no issue)', () => {
    for (const ind of run(SOURCES, {}).indicators) expect(ind.state).toBe(PULSE_STATE.UNAVAILABLE)
  })
})

// ── 2 · Dependency isolation, verified by perturbation ───────────────────────

describe('dependency isolation — each indicator waits on exactly the sources that move it', () => {
  // The comparable part of an evaluation: everything except the fields that
  // repeat the source-state verdict.
  const outcome = (ind) => JSON.stringify({ s: ind.state, r: ind.reason, h: ind.headline, v: ind.values, e: ind.evidence, c: ind.caveats })
  const baseline = byId(run())

  for (const id of INDICATOR_ORDER) {
    const deps = INDICATOR_DEPENDENCIES[id]
    const undeclared = PULSE_SOURCES.filter(s => !deps.includes(s))

    for (const dep of deps) {
      it(`${id}: emptying DECLARED source ${dep} changes the result`, () => {
        expect(outcome(get(id, emptied(dep)))).not.toBe(outcome(baseline[id]))
      })
    }
    for (const src of undeclared) {
      it(`${id}: emptying UNDECLARED source ${src} leaves the result unchanged`, () => {
        expect(outcome(get(id, emptied(src)))).toBe(outcome(baseline[id]))
      })
      it(`${id}: a FAILED undeclared source ${src} does not block it`, () => {
        const ind = get(id, SOURCES, withState({ [src]: settled(false, true) }))
        expect(ind.state).toBe(baseline[id].state)
        expect(outcome(ind)).toBe(outcome(baseline[id]))
      })
    }
  }

  it('the forecast indicators declare the Dashboard\'s FORECAST_ROW_SOURCES; past due declares remainingPayable\'s sources', () => {
    expect(INDICATOR_DEPENDENCIES[INDICATOR.FORECAST_OVER_BUDGET]).toEqual(
      ['budgetLines', 'purchaseOrders', 'progressClaims', 'supplierInvoices', 'supplierCreditNotes', 'variations', 'forecastLines'],
    )
    expect(INDICATOR_DEPENDENCIES[INDICATOR.NEGATIVE_GROSS_PROFIT]).toEqual(
      ['baseline', 'budgetLines', 'purchaseOrders', 'progressClaims', 'supplierInvoices', 'supplierCreditNotes', 'variations', 'forecastLines'],
    )
    expect(INDICATOR_DEPENDENCIES[INDICATOR.PAST_DUE_SUPPLIER_INVOICES]).toEqual(
      ['supplierInvoices', 'supplierPayments', 'supplierCreditNotes', 'retentionReleases'],
    )
    expect(INDICATOR_DEPENDENCIES[INDICATOR.OVERDUE_ACTIVITIES]).toEqual(['activities'])
    expect(INDICATOR_DEPENDENCIES[INDICATOR.PENDING_VARIATION_EXPOSURE]).toEqual(['variations'])
  })
})

// ── 3 · Financial consistency: PULSE figures ARE the selectors' ──────────────

describe('financial consistency — every PULSE amount is an existing selector output', () => {
  const { baseline, activities, supplierPayments, retentionReleases, ...forecastSrc } = SOURCES
  const totals = projectForecastTotals(forecastSrc)
  const margin = computeMargin({ baseline, variations: SOURCES.variations, forecastFinalCost: totals.forecastFinalCost })
  const ind = byId(run())

  it('over budget: Approved Budget, FFC and Variance equal projectForecastTotals', () => {
    const v = ind[INDICATOR.FORECAST_OVER_BUDGET].values
    expect(v.approvedBudget).toBe(totals.budgeted)
    expect(v.forecastFinalCost).toBe(totals.forecastFinalCost)
    expect(v.varianceToBudget).toBe(totals.varianceToBudget)
    expect(v.unforecastedCount).toBe(totals.unforecastedCount)
    expect(v.overBudgetCount).toBe(totals.overBudgetCount)
    expect(totals.varianceToBudget).toBeLessThan(0) // a real over-budget fixture
  })

  it('over budget evidence rows are exactly the composed rows flagged overBudget', () => {
    const rows = projectForecastRows(forecastSrc)
    const expected = rows.filter(r => r.overBudget).map(r => r.costCodeId).sort()
    expect(ind[INDICATOR.FORECAST_OVER_BUDGET].evidence.map(r => r.costCodeId).sort()).toEqual(expected)
    expect(expected.length).toBeGreaterThan(0)
    for (const e of ind[INDICATOR.FORECAST_OVER_BUDGET].evidence) {
      const row = rows.find(r => r.costCodeId === e.costCodeId)
      expect(e.varianceToBudget).toBe(row.varianceToBudget)
      expect(e.forecastFinalCost).toBe(row.forecastFinalCost)
    }
  })

  it('incomplete: evidence rows are exactly the composed rows flagged unforecasted (saved 0 is a forecast)', () => {
    const rows = projectForecastRows(forecastSrc)
    const expected = rows.filter(r => r.unforecasted).map(r => r.costCodeId).sort()
    expect(ind[INDICATOR.FORECAST_INCOMPLETE].evidence.map(r => r.costCodeId).sort()).toEqual(expected)
    expect(ind[INDICATOR.FORECAST_INCOMPLETE].values.unforecastedCount).toBe(totals.unforecastedCount)
    expect(ind[INDICATOR.FORECAST_INCOMPLETE].values.lineCount).toBe(totals.lineCount)
    expect(expected).toContain('cc2') // null input
    expect(expected).not.toContain('cc1') // saved 150
  })

  it('gross profit figures equal computeMargin', () => {
    const v = ind[INDICATOR.NEGATIVE_GROSS_PROFIT].values
    expect(v.currentContractSum).toBe(margin.currentContractSum)
    expect(v.forecastFinalCost).toBe(margin.forecastFinalCost)
    expect(v.forecastGrossProfit).toBe(margin.forecastGrossProfit)
    expect(v.forecastMarginPct).toBe(margin.forecastMarginPct)
  })

  it('past due figures equal payablesSummary / apAgeing / paymentSummary', () => {
    const released = releasedByInvoiceId(retentionReleases)
    const payables = payablesSummary(SOURCES.supplierInvoices, supplierPayments, SOURCES.supplierCreditNotes, released)
    const ageing = apAgeing(SOURCES.supplierInvoices, supplierPayments, SOURCES.supplierCreditNotes, released, NOW)
    const v = ind[INDICATOR.PAST_DUE_SUPPLIER_INVOICES].values
    expect(v.pastDueTotal).toBe(ageing.pastDue)
    expect(v.remainingPayable).toBe(payables.remaining)
    expect(v.postedInvoiceCount).toBe(payables.count)
    expect(v.unallocatedPayments).toBe(paymentSummary(supplierPayments).unallocated)
    // The listed rows sum to the ageing past-due total (two routes, one figure).
    const listed = ind[INDICATOR.PAST_DUE_SUPPLIER_INVOICES].evidence.reduce((a, r) => a + r.remaining, 0)
    expect(Math.round(listed * 100)).toBe(Math.round(ageing.pastDue * 100))
    for (const e of ind[INDICATOR.PAST_DUE_SUPPLIER_INVOICES].evidence) {
      expect(e.remaining).toBe(payables.rows.find(r => r.id === e.id).remaining)
    }
  })

  it('pending exposure equals the variation selectors, split by status without double counting', () => {
    const v = ind[INDICATOR.PENDING_VARIATION_EXPOSURE].values
    expect(v.supplier.exposure).toBe(pendingSupplierVariationExposureTotal(SOURCES.variations))
    expect(v.client.exposure).toBe(pendingClientVariationExposureTotal(SOURCES.variations))
    expect(Math.round((v.supplier.draft + v.supplier.submitted) * 100)).toBe(Math.round(v.supplier.exposure * 100))
    expect(Math.round((v.client.draft + v.client.submitted) * 100)).toBe(Math.round(v.client.exposure * 100))
    expect(v.supplier).toMatchObject({ count: 2, draftCount: 1, submittedCount: 1, exposure: 95, draft: 25, submitted: 70 })
    expect(v.client).toMatchObject({ count: 1, draftCount: 0, submittedCount: 1, exposure: 300, draft: 0, submitted: 300 })
    // Approved and rejected variations are not exposure.
    const ids = ind[INDICATOR.PENDING_VARIATION_EXPOSURE].evidence.map(e => e.id).sort()
    expect(ids).toEqual(['v2', 'v4', 'v5'])
  })

  it('pending amounts are NOT inside FFC or the Current Contract Sum (no double count)', () => {
    // Removing every pending variation changes neither the cost nor the revenue side.
    const noPending = { ...SOURCES, variations: SOURCES.variations.filter(v => !['draft', 'submitted'].includes(v.status)) }
    const a = byId(run(noPending))
    expect(a[INDICATOR.FORECAST_OVER_BUDGET].values.forecastFinalCost).toBe(ind[INDICATOR.FORECAST_OVER_BUDGET].values.forecastFinalCost)
    expect(a[INDICATOR.NEGATIVE_GROSS_PROFIT].values.currentContractSum).toBe(margin.currentContractSum)
    expect(a[INDICATOR.NEGATIVE_GROSS_PROFIT].values.forecastGrossProfit).toBe(margin.forecastGrossProfit)
  })

  it('overdue counts equal timelineSummary', () => {
    const s = timelineSummary(activities, NOW)
    expect(ind[INDICATOR.OVERDUE_ACTIVITIES].values).toEqual({ overdue: s.overdue, open: s.open, total: s.total })
    expect(ind[INDICATOR.OVERDUE_ACTIVITIES].evidence.length).toBe(s.overdue)
  })

  it('the Dashboard snapshot for the same fixture is unchanged by PULSE (byte-for-byte figures)', () => {
    const snap = projectSnapshot({
      sources: { ...SOURCES },
      sourceStates: Object.fromEntries(SNAPSHOT_SOURCES.map(s => [s, settled()])),
      currencyCode: 'AUD',
    })
    expect(snap.approvedBudget.value).toBe(ind[INDICATOR.FORECAST_OVER_BUDGET].values.approvedBudget)
    expect(snap.forecastFinalCost.value).toBe(ind[INDICATOR.FORECAST_OVER_BUDGET].values.forecastFinalCost)
    expect(snap.varianceToBudget.value).toBe(ind[INDICATOR.FORECAST_OVER_BUDGET].values.varianceToBudget)
    expect(snap.margin.grossProfit).toBe(ind[INDICATOR.NEGATIVE_GROSS_PROFIT].values.forecastGrossProfit)
    expect(snap.remainingPayable.value).toBe(ind[INDICATOR.PAST_DUE_SUPPLIER_INVOICES].values.remainingPayable)
    expect(snap.forecastFinalCost.state).toBe(FIGURE_STATE.READY)
  })
})

// ── 4 · Phase 3: projectForecastRows is the one composition ──────────────────

describe('projectForecastRows — the extraction preserves projectForecastTotals exactly', () => {
  const { baseline, activities, supplierPayments, retentionReleases, ...src } = SOURCES
  void baseline; void activities; void supplierPayments; void retentionReleases

  it('rows are buildForecastRows mapped through composeForecastRow at the SAVED input', () => {
    const expected = buildForecastRows(src).map(r => composeForecastRow(r, r.storedUncommittedCostToComplete))
    expect(projectForecastRows(src)).toEqual(expected)
  })

  it('projectForecastTotals === forecastRollups(projectForecastRows) — same object shape and figures', () => {
    expect(projectForecastTotals(src)).toEqual(forecastRollups(projectForecastRows(src)))
  })

  it('regression pin — the fixture\'s rollup figures', () => {
    const t = projectForecastTotals(src)
    // cc1: budget 1000, actual 600 (inv1) + 2000 (inv2) + 500 (inv4) − 100 credit = 3000, committed 800−600−2000−500 → 0 floor? (matured: 800 − 3100 → clamp 0)
    expect(t.budgeted).toBe(1800)
    expect(t.unforecastedCount).toBeGreaterThan(0)
    expect(t.forecastFinalCost).toBe(forecastRollups(projectForecastRows(src)).forecastFinalCost)
    expect(t.varianceToBudget).toBe(Math.round((t.budgeted - t.forecastFinalCost) * 100) / 100)
  })

  it('an empty project yields empty rows and a zero rollup', () => {
    expect(projectForecastRows({})).toEqual([])
    expect(projectForecastTotals({}).forecastFinalCost).toBe(0)
    expect(projectForecastTotals({}).lineCount).toBe(0)
  })

  it('margin.js composes through the shared helper only once (no second copy)', () => {
    const margin = read('lib/margin.js')
    expect(margin.match(/composeForecastRow\(/g)).toHaveLength(1)
    expect(margin).toContain('return forecastRollups(projectForecastRows(sources))')
  })
})

// ── 5 · Indicator 1 — Forecast Final Cost exceeds Approved Budget ────────────

describe('indicator 1 — Forecast Final Cost exceeds Approved Budget', () => {
  const id = INDICATOR.FORECAST_OVER_BUDGET
  // A fully forecast, within-budget project.
  const healthy = {
    ...SOURCES,
    budgetLines: [{ id: 'b', costCodeId: 'cc1', budgeted: 5000 }],
    purchaseOrders: [{ id: 'po', status: 'sent', lineItems: [{ costCodeId: 'cc1', lineTotal: 1000 }] }],
    progressClaims: [], supplierInvoices: [], supplierCreditNotes: [], variations: [],
    forecastLines: [{ id: 'cc1', costCodeId: 'cc1', uncommittedCostToComplete: 500 }],
  }

  it('finding when variance is negative, with the over-budget rows and the incomplete caveat', () => {
    const ind = get(id)
    expect(ind.state).toBe(PULSE_STATE.FINDING)
    expect(ind.values.varianceToBudget).toBeLessThan(0)
    expect(ind.evidence.length).toBeGreaterThan(0)
    expect(ind.evidence.every(r => r.overBudget && r.hasBudgetLine)).toBe(true)
    expect(ind.caveats.join(' ')).toMatch(/no saved forecast/)
    expect(ind.caveats.join(' ')).not.toMatch(/at least|lower bound|guarantee/i)
    expect(ind.link).toEqual(INDICATOR_LINKS[id])
  })

  it('unbudgeted cost codes carrying cost are listed separately, never as over budget', () => {
    const ind = get(id)
    const unb = ind.values.unbudgetedRows.map(r => r.costCodeId)
    expect(unb.length).toBeGreaterThan(0)
    for (const r of ind.values.unbudgetedRows) expect(r.hasBudgetLine).toBe(false)
    for (const r of ind.evidence) expect(unb).not.toContain(r.costCodeId)
  })

  it('no issue when fully forecast and within budget (a genuine negative)', () => {
    const ind = get(id, healthy)
    expect(ind.state).toBe(PULSE_STATE.NO_ISSUE)
    expect(ind.values).toMatchObject({ approvedBudget: 5000, forecastFinalCost: 1500, varianceToBudget: 3500, unforecastedCount: 0 })
    expect(ind.caveats).toEqual([])
  })

  it('needs data (forecast incomplete) when within budget but a cost code is not forecast — never "no issue"', () => {
    const ind = get(id, { ...healthy, forecastLines: [] })
    expect(ind.state).toBe(PULSE_STATE.NEEDS_DATA)
    expect(ind.reason).toBe(NEEDS_DATA_REASON.FORECAST_INCOMPLETE)
    expect(ind.values.unforecastedCount).toBe(1)
    expect(ind.caveats).toHaveLength(1)
  })

  it('a saved 0 IS a forecast: zero CTC everywhere → no issue, not needs data', () => {
    const ind = get(id, { ...healthy, forecastLines: [{ id: 'cc1', costCodeId: 'cc1', uncommittedCostToComplete: 0 }] })
    expect(ind.state).toBe(PULSE_STATE.NO_ISSUE)
    expect(ind.values.forecastFinalCost).toBe(1000)
  })

  it('a finding stands despite an incomplete forecast, with the caveat', () => {
    const ind = get(id, { ...healthy, budgetLines: [{ id: 'b', costCodeId: 'cc1', budgeted: 900 }], forecastLines: [] })
    expect(ind.state).toBe(PULSE_STATE.FINDING)
    expect(ind.values.varianceToBudget).toBe(-100)
    expect(ind.caveats).toHaveLength(1)
  })

  it('needs data (no budget) when there are no budget lines', () => {
    const ind = get(id, { ...healthy, budgetLines: [] })
    expect(ind.state).toBe(PULSE_STATE.NEEDS_DATA)
    expect(ind.reason).toBe(NEEDS_DATA_REASON.NO_BUDGET)
    expect(ind.link.to).toBe('budget')
  })

  it('cent boundary: exactly on budget is no issue; one cent over is a finding', () => {
    const exact = get(id, { ...healthy, budgetLines: [{ id: 'b', costCodeId: 'cc1', budgeted: 1500 }] })
    expect(exact.state).toBe(PULSE_STATE.NO_ISSUE)
    expect(exact.values.varianceToBudget).toBe(0)
    const cent = get(id, { ...healthy, budgetLines: [{ id: 'b', costCodeId: 'cc1', budgeted: 1499.99 }] })
    expect(cent.state).toBe(PULSE_STATE.FINDING)
    expect(cent.values.varianceToBudget).toBe(-0.01)
    // Sub-cent noise rounds away.
    const noise = get(id, { ...healthy, budgetLines: [{ id: 'b', costCodeId: 'cc1', budgeted: 1499.996 }] })
    expect(noise.state).toBe(PULSE_STATE.NO_ISSUE)
  })

  it('a genuine zero budget with zero cost is no issue — zero is not "missing"', () => {
    const ind = get(id, { ...healthy, budgetLines: [{ id: 'b', costCodeId: 'cc1', budgeted: 0 }], purchaseOrders: [], forecastLines: [{ id: 'cc1', costCodeId: 'cc1', uncommittedCostToComplete: 0 }] })
    expect(ind.state).toBe(PULSE_STATE.NO_ISSUE)
    expect(ind.values).toMatchObject({ approvedBudget: 0, forecastFinalCost: 0, varianceToBudget: 0 })
  })
})

// ── 6 · Indicator 2 — cost codes not yet forecast ────────────────────────────

describe('indicator 2 — cost codes not yet forecast', () => {
  const id = INDICATOR.FORECAST_INCOMPLETE

  it('finding lists every unforecast row with its budget, actual and committed', () => {
    const ind = get(id)
    expect(ind.state).toBe(PULSE_STATE.FINDING)
    for (const r of ind.evidence) {
      expect(r.unforecasted).toBe(true)
      for (const k of ['costCodeName', 'budgeted', 'actual', 'remainingCommitted']) expect(r).toHaveProperty(k)
    }
    expect(ind.headline).toMatch(new RegExp(`^${ind.evidence.length} of ${ind.values.lineCount} cost codes`))
  })

  it('a variation-only, budget-only or PO-only cost code with no forecast line counts', () => {
    const ids = get(id).evidence.map(r => r.costCodeId)
    expect(ids).toContain('cc7') // approved supplier variation only
    expect(ids).toContain('cc5') // budget line only
    expect(ids).toContain('cc6') // sent PO only
  })

  it('no issue once every row has a saved input — a saved 0 counts', () => {
    const rows = projectForecastRows(SOURCES)
    const forecastLines = rows.map(r => ({ id: r.costCodeId, costCodeId: r.costCodeId, uncommittedCostToComplete: 0 }))
    const ind = get(id, { ...SOURCES, forecastLines })
    expect(ind.state).toBe(PULSE_STATE.NO_ISSUE)
    expect(ind.values.unforecastedCount).toBe(0)
    expect(ind.evidence).toEqual([])
  })

  it('needs data when the project has no cost-code rows at all', () => {
    const empty = { ...SOURCES, budgetLines: [], purchaseOrders: [], progressClaims: [], supplierInvoices: [], supplierCreditNotes: [], variations: [], forecastLines: [] }
    const ind = get(id, empty)
    expect(ind.state).toBe(PULSE_STATE.NEEDS_DATA)
    expect(ind.reason).toBe(NEEDS_DATA_REASON.NO_COST_CODES)
    expect(ind.values.lineCount).toBe(0)
  })
})

// ── 7 · Indicator 3 — negative Forecast Gross Profit ─────────────────────────

describe('indicator 3 — Forecast Gross Profit is negative', () => {
  const id = INDICATOR.NEGATIVE_GROSS_PROFIT
  const fullyForecast = () => {
    const rows = projectForecastRows(SOURCES)
    return rows.map(r => ({ id: r.costCodeId, costCodeId: r.costCodeId, uncommittedCostToComplete: r.storedUncommittedCostToComplete ?? 0 }))
  }

  it('needs data (contract not set) when the baseline has no Original Contract Value — never a $0 profit', () => {
    for (const baseline of [null, {}, { originalContractValue: null }, { originalContractValue: '1000' }]) {
      const ind = get(id, { ...SOURCES, baseline })
      expect(ind.state).toBe(PULSE_STATE.NEEDS_DATA)
      expect(ind.reason).toBe(NEEDS_DATA_REASON.CONTRACT_NOT_SET)
      expect(ind.values.forecastGrossProfit).toBeUndefined()
      expect(ind.link.to).toBe('commercial')
    }
  })

  it('baseline loading → loading; baseline failed → unavailable (not "contract not set")', () => {
    expect(get(id, SOURCES, withState({ baseline: settled(true, false) })).state).toBe(PULSE_STATE.LOADING)
    expect(get(id, SOURCES, withState({ baseline: settled(false, true) })).state).toBe(PULSE_STATE.UNAVAILABLE)
  })

  it('needs data (forecast incomplete) when profit is positive but a cost code is not forecast', () => {
    const ind = get(id)
    expect(ind.values.forecastGrossProfit).toBeGreaterThan(0)
    expect(ind.state).toBe(PULSE_STATE.NEEDS_DATA)
    expect(ind.reason).toBe(NEEDS_DATA_REASON.FORECAST_INCOMPLETE)
    expect(ind.caveats).toHaveLength(1)
  })

  it('no issue when fully forecast and profit is zero or positive', () => {
    const ind = get(id, { ...SOURCES, forecastLines: fullyForecast() })
    expect(ind.state).toBe(PULSE_STATE.NO_ISSUE)
    expect(ind.values.forecastGrossProfit).toBeGreaterThanOrEqual(0)
    expect(ind.caveats).toEqual([])
  })

  it('finding when profit is negative — stands even with an incomplete forecast, caveated', () => {
    const ind = get(id, { ...SOURCES, baseline: { originalContractValue: 100, originalApprovedBudget: 1500 } })
    expect(ind.state).toBe(PULSE_STATE.FINDING)
    expect(ind.values.forecastGrossProfit).toBeLessThan(0)
    expect(ind.caveats).toHaveLength(1)
    const complete = get(id, { ...SOURCES, baseline: { originalContractValue: 100 }, forecastLines: fullyForecast() })
    expect(complete.state).toBe(PULSE_STATE.FINDING)
    expect(complete.caveats).toEqual([])
  })

  it('cent boundary on profit: zero profit is no issue, −$0.01 is a finding; margin % is null on non-positive revenue', () => {
    const src = { ...SOURCES, forecastLines: fullyForecast() }
    const ffc = projectForecastTotals(src).forecastFinalCost
    const approvedClient = 2000
    const exact = get(id, { ...src, baseline: { originalContractValue: Math.round((ffc - approvedClient) * 100) / 100 } })
    expect(exact.state).toBe(PULSE_STATE.NO_ISSUE)
    expect(exact.values.forecastGrossProfit).toBe(0)
    const cent = get(id, { ...src, baseline: { originalContractValue: Math.round((ffc - approvedClient - 0.01) * 100) / 100 } })
    expect(cent.state).toBe(PULSE_STATE.FINDING)
    expect(cent.values.forecastGrossProfit).toBe(-0.01)
    const negativeRevenue = get(id, { ...src, baseline: { originalContractValue: -5000 } })
    expect(negativeRevenue.state).toBe(PULSE_STATE.FINDING)
    expect(negativeRevenue.values.forecastMarginPct).toBeNull()
  })

  it('pending client variations do not raise the Current Contract Sum', () => {
    const withoutPendingClient = { ...SOURCES, variations: SOURCES.variations.filter(v => v.id !== 'v2') }
    expect(get(id, withoutPendingClient).values.currentContractSum).toBe(get(id).values.currentContractSum)
  })
})

// ── 8 · Indicator 4 — overdue programme activities ───────────────────────────

describe('indicator 4 — programme activities overdue', () => {
  const id = INDICATOR.OVERDUE_ACTIVITIES

  it('finding lists open activities past planned finish, most late first, with days late', () => {
    const ind = get(id)
    expect(ind.state).toBe(PULSE_STATE.FINDING)
    expect(ind.evidence.map(r => r.id)).toEqual(['a1', 'a2'])
    expect(ind.evidence[0]).toMatchObject({ name: 'Excavate', daysLate: 14, plannedFinish: '2026-03-01', responsibleName: 'J. Smith', costCodeName: '02-100 — Earthworks' })
    expect(ind.evidence[1]).toMatchObject({ name: 'Slab pour', daysLate: 1, responsibleName: '', costCodeName: '' })
    expect(ind.values).toEqual({ overdue: 2, open: 4, total: 6 })
  })

  it('an activity due TODAY is not overdue; completed and cancelled work is never overdue', () => {
    const ids = get(id).evidence.map(r => r.id)
    expect(ids).not.toContain('a3') // finishes today
    expect(ids).not.toContain('a4') // completed (and a past milestone)
    expect(ids).not.toContain('a5') // cancelled
    expect(ids).not.toContain('a6') // future milestone
  })

  it('a milestone is labelled as one', () => {
    const late = { ...SOURCES, activities: [{ id: 'm', name: 'Handover', status: 'not_started', isMilestone: true, plannedStart: '2026-01-01', plannedFinish: '2026-01-01' }] }
    expect(get(id, late).evidence[0].name).toBe('Handover (milestone)')
  })

  it('uses the supplied local day — the same records flip with the clock', () => {
    const earlier = get(id, SOURCES, allSettled(), new Date(2026, 1, 1))
    expect(earlier.state).toBe(PULSE_STATE.NO_ISSUE)
    const later = get(id, SOURCES, allSettled(), new Date(2026, 2, 16))
    expect(later.evidence.map(r => r.id)).toEqual(['a1', 'a2', 'a3'])
  })

  it('no issue when every open activity finishes today or later (counts shown, not percentages)', () => {
    const ind = get(id, SOURCES, allSettled(), new Date(2026, 1, 1))
    expect(ind.state).toBe(PULSE_STATE.NO_ISSUE)
    expect(ind.values.open).toBe(4)
    // The figures and headline carry counts only (the caveat SAYS "never a
    // completion percentage", which is the point).
    expect(JSON.stringify({ h: ind.headline, v: ind.values, e: ind.evidence })).not.toMatch(/%|percent/i)
    for (const v of Object.values(ind.values)) expect(Number.isInteger(v)).toBe(true)
  })

  it('needs data when the programme is empty', () => {
    const ind = get(id, { ...SOURCES, activities: [] })
    expect(ind.state).toBe(PULSE_STATE.NEEDS_DATA)
    expect(ind.reason).toBe(NEEDS_DATA_REASON.NO_PROGRAMME)
    expect(ind.link.to).toBe('timeline')
  })

  it('always states that the programme is a manually maintained current plan', () => {
    for (const src of [SOURCES, { ...SOURCES, activities: [SOURCES.activities[5]] }]) {
      expect(get(id, src).caveats.join(' ')).toMatch(/manually maintained current plan/)
    }
  })
})

// ── 9 · Indicator 5 — supplier invoices past due ─────────────────────────────

describe('indicator 5 — supplier invoices past due with a remaining payable balance', () => {
  const id = INDICATOR.PAST_DUE_SUPPLIER_INVOICES

  it('finding lists past-due posted invoices with a positive remaining balance, most overdue first', () => {
    const ind = get(id)
    expect(ind.state).toBe(PULSE_STATE.FINDING)
    expect(ind.evidence.map(r => r.id)).toEqual(['inv1', 'inv2'])
    expect(ind.evidence[0]).toMatchObject({ invoiceNumber: 'SI-0001', supplierName: 'Ace Concrete', dueDate: '2026-01-31', daysPastDue: 43 })
    expect(ind.evidence[1]).toMatchObject({ invoiceNumber: 'SI-0002', daysPastDue: 15 })
  })

  it('uses REMAINING payable: inv1 = 1100 payable − 500 paid − 110 credited = 490, not the face value', () => {
    const row = get(id).evidence.find(r => r.id === 'inv1')
    expect(row.remaining).toBe(490)
    expect(row.grossTotal).toBe(1100)
    expect(row.paid).toBe(500)
    expect(row.credited).toBe(110)
  })

  it('respects retention: inv2 basis = payableTotal 2090 + posted release 55 (not grossTotal 2200, not the draft release)', () => {
    const row = get(id).evidence.find(r => r.id === 'inv2')
    expect(row.remaining).toBe(2145)
    expect(row.payableTotal).toBe(2145)
    expect(row.retentionHeld).toBe(55)
    expect(get(id).caveats.join(' ')).toMatch(/Released retention/)
  })

  it('a fully settled past-due invoice is NOT listed; a not-yet-due one is NOT listed; a draft is NOT listed', () => {
    const ids = get(id).evidence.map(r => r.id)
    expect(ids).not.toContain('inv3')
    expect(ids).not.toContain('inv4')
    expect(ids).not.toContain('inv5')
  })

  it('a draft payment settles nothing', () => {
    const noDraft = { ...SOURCES, supplierPayments: SOURCES.supplierPayments.filter(p => p.status !== 'draft') }
    expect(get(id, noDraft).evidence).toEqual(get(id).evidence)
  })

  it('voiding the posted payment restores inv1 to its full remaining (490 → 990)', () => {
    const voided = { ...SOURCES, supplierPayments: SOURCES.supplierPayments.map(p => p.id === 'sp1' ? { ...p, status: 'void' } : p) }
    expect(get(id, voided).evidence.find(r => r.id === 'inv1').remaining).toBe(990)
    expect(get(id, voided).values.unallocatedPayments).toBe(0)
  })

  it('a partly settled invoice ages only its remainder, and the total is apAgeing.pastDue', () => {
    const ind = get(id)
    expect(ind.values.pastDueTotal).toBe(490 + 2145)
    expect(ind.values.pastDueCount).toBe(2)
  })

  it('surfaces the unallocated-payment caveat only when unallocated cash exists', () => {
    expect(get(id).values.unallocatedPayments).toBe(200)
    expect(get(id).caveats.join(' ')).toMatch(/not yet allocated/)
    const allocated = { ...SOURCES, supplierPayments: SOURCES.supplierPayments.map(p => p.id === 'sp1' ? { ...p, unallocatedAmount: 0 } : p) }
    expect(get(id, allocated).caveats.join(' ')).not.toMatch(/not yet allocated/)
  })

  it('never describes a past-due balance as definitively unpaid', () => {
    const ind = get(id)
    expect(ind.caveats.join(' ')).toMatch(/not proof the supplier is unpaid/)
    expect(`${ind.headline} ${ind.explanation}`).not.toMatch(/\bunpaid\b/i)
  })

  it('missing due dates: counted and caveated; alone they are needs data, never no issue', () => {
    const undated = { ...SOURCES, supplierInvoices: [{ ...inv2, dueDate: '' }], supplierPayments: [], supplierCreditNotes: [], retentionReleases: [] }
    const ind = get(id, undated)
    expect(ind.state).toBe(PULSE_STATE.NEEDS_DATA)
    expect(ind.reason).toBe(NEEDS_DATA_REASON.DUE_DATES_MISSING)
    expect(ind.values.missingDueDateCount).toBe(1)
    expect(ind.caveats.join(' ')).toMatch(/no due date/)
    // With a dated past-due invoice as well, it is a finding and the caveat still shows.
    const mixed = { ...undated, supplierInvoices: [{ ...inv2, dueDate: '' }, inv1] }
    expect(get(id, mixed).state).toBe(PULSE_STATE.FINDING)
    expect(get(id, mixed).caveats.join(' ')).toMatch(/no due date/)
  })

  it('no issue: no posted invoices, or none past due with a balance — a genuine negative', () => {
    const none = get(id, { ...SOURCES, supplierInvoices: [], supplierPayments: [], supplierCreditNotes: [], retentionReleases: [] })
    expect(none.state).toBe(PULSE_STATE.NO_ISSUE)
    expect(none.values).toMatchObject({ pastDueCount: 0, pastDueTotal: 0, remainingPayable: 0, postedInvoiceCount: 0 })
    const current = get(id, { ...SOURCES, supplierInvoices: [inv3, inv4] })
    expect(current.state).toBe(PULSE_STATE.NO_ISSUE)
    expect(current.values.remainingPayable).toBe(550)
  })

  it('the clock decides: on 1 Feb 2026 only inv1 is past due', () => {
    const ind = get(id, SOURCES, allSettled(), new Date(2026, 1, 1))
    expect(ind.evidence.map(r => r.id)).toEqual(['inv1'])
    expect(ind.evidence[0].daysPastDue).toBe(1)
  })

  it('a failed retention-release read makes the indicator unavailable (never a "nothing released" guess)', () => {
    expect(get(id, SOURCES, withState({ retentionReleases: settled(false, true) })).state).toBe(PULSE_STATE.UNAVAILABLE)
  })
})

// ── 10 · Indicator 6 — pending variation exposure ────────────────────────────

describe('indicator 6 — pending variation exposure', () => {
  const id = INDICATOR.PENDING_VARIATION_EXPOSURE

  it('finding with supplier and client exposure separated, draft and submitted distinguished', () => {
    const ind = get(id)
    expect(ind.state).toBe(PULSE_STATE.FINDING)
    expect(ind.headline).toBe('3 pending variations — 2 supplier, 1 client')
    expect(ind.evidence.map(e => `${e.variationNumber}:${e.typeLabel}:${e.statusLabel}`)).toEqual([
      'CV-0002:Client:Submitted', 'SV-0002:Supplier:Submitted', 'SV-0003:Supplier:Draft',
    ])
    expect(ind.evidence.find(e => e.id === 'v2').counterparty).toBe('Owner Co')
    expect(ind.evidence.find(e => e.id === 'v4').counterparty).toBe('Ace Concrete')
    expect(ind.evidence.find(e => e.id === 'v4').submittedSubtotal).toBe(70)
  })

  it('is described as exposure, not an error or overdue condition', () => {
    const ind = get(id)
    expect(ind.caveats.join(' ')).toMatch(/Exposure, not an error/)
    expect(`${ind.headline} ${ind.explanation}`).not.toMatch(/overdue|error|late/i)
  })

  it('no issue when nothing is pending — approved and rejected variations are not exposure', () => {
    const closedOnly = { ...SOURCES, variations: SOURCES.variations.filter(v => ['approved', 'rejected'].includes(v.status)) }
    const ind = get(id, closedOnly)
    expect(ind.state).toBe(PULSE_STATE.NO_ISSUE)
    expect(ind.values.pendingCount).toBe(0)
    expect(ind.values.supplier.exposure).toBe(0)
    expect(ind.values.client.exposure).toBe(0)
  })

  it('an empty variation list is a genuine no issue (variations settled, simply none)', () => {
    expect(get(id, { ...SOURCES, variations: [] }).state).toBe(PULSE_STATE.NO_ISSUE)
  })

  it('a DRAFT with an entered amount: shown under a neutral "Amount" column, counted in draft exposure, zero formally submitted', () => {
    // submittedSubtotal is written at draft creation (the "submitted side" of
    // the lines), so a draft carries an amount before anything is formally
    // submitted — the column must not call it "Submitted".
    const draftOnly = { ...SOURCES, variations: [
      { id: 'd', variationNumber: 'CV-0010', title: 'Window Color', variationType: 'client', status: 'draft', submittedSubtotal: 2000, clientName: 'Owner Co', lineItems: [] },
    ] }
    const ind = get(id, draftOnly)
    expect(ind.state).toBe(PULSE_STATE.FINDING)
    expect(ind.evidence).toHaveLength(1)
    expect(ind.evidence[0]).toMatchObject({ variationNumber: 'CV-0010', statusLabel: 'Draft', submittedSubtotal: 2000 })
    const amountCol = ind.evidenceColumns.find(c => c.key === 'submittedSubtotal')
    expect(amountCol.label).toBe('Amount (ex-GST)')
    for (const c of ind.evidenceColumns) expect(c.label).not.toMatch(/submitted/i)
    // Exposure keeps the status split: all of it is draft, none formally submitted.
    expect(ind.values.client).toMatchObject({ count: 1, draftCount: 1, submittedCount: 0, exposure: 2000, draft: 2000, submitted: 0 })
    expect(ind.values.supplier).toMatchObject({ count: 0, exposure: 0, draft: 0, submitted: 0 })
    expect(ind.explanation).toMatch(/draft's amount has not yet been formally submitted/)
  })

  it('a negative (omission) pending variation is carried signed, never clamped', () => {
    const neg = { ...SOURCES, variations: [{ id: 'n', variationNumber: 'SV-0009', variationType: 'supplier', status: 'submitted', submittedSubtotal: -40, lineItems: [] }] }
    const ind = get(id, neg)
    expect(ind.values.supplier.exposure).toBe(-40)
    expect(ind.values.supplier.submitted).toBe(-40)
    expect(ind.values.supplier.draft).toBe(0)
  })
})

// ── 11 · The engine computes no money and imports no Firebase ────────────────

describe('lib/pulse.js — composition only', () => {
  const src = stripComments(read('lib/pulse.js'))

  it('imports no Firebase and no React', () => {
    expect(src).not.toMatch(/from 'firebase/)
    expect(src).not.toMatch(/from 'react/)
  })

  it('performs no money arithmetic of its own: no sum, product or division; subtraction only in sort comparators', () => {
    // String literals removed first, so prose and route paths ('commercial/…')
    // cannot masquerade as operators.
    const bare = src
      .replace(/`(?:\\.|[^`\\])*`/g, '``')
      .replace(/'(?:\\.|[^'\\])*'/g, "''")
      .replace(/"(?:\\.|[^"\\])*"/g, '""')
    // roundMoney appears only inside the one comparison helper.
    expect(src.match(/roundMoney\(/g)).toHaveLength(1)
    expect(bare).not.toMatch(/\.reduce\(/)
    expect(bare).not.toMatch(/[a-zA-Z)\]]\s*[*/]\s*[a-zA-Z(]/) // no multiplication or division between operands
    // Every `+` is string concatenation (adjacent to a literal) or a `+= 1` count.
    for (const line of bare.match(/^.*\+.*$/gm) ?? []) {
      expect(line, line).toMatch(/['`"]\s*\+|\+\s*['`"]|\+= 1|\+\s*$|^\s*\+/)
    }
    // Every binary minus sits inside an arrow comparator (ordering, not a figure).
    for (const line of bare.match(/^.*\S\s+-\s+\S.*$/gm) ?? []) {
      expect(line, line).toMatch(/=>/)
    }
  })

  it('every amount comes from a named selector', () => {
    for (const fn of ['projectForecastRows', 'projectForecastTotals', 'computeMargin', 'payablesSummary', 'apAgeing', 'paymentSummary', 'isPastDuePayable', 'isOverdue', 'daysLate', 'timelineSummary', 'pendingSupplierVariationExposureTotal', 'pendingClientVariationExposureTotal', 'releasedByInvoiceId', 'figureState']) {
      expect(src, fn).toMatch(new RegExp(`\\b${fn}\\(`))
    }
  })

  it('no score, severity, threshold, trend or prediction vocabulary', () => {
    for (const word of ['score', 'severity', 'threshold', 'trend', 'predict', 'risk level', 'weight']) {
      expect(src.toLowerCase(), word).not.toContain(word)
    }
    expect(src).not.toMatch(/Math\.(max|min)\(/)
  })

  it('formats no currency itself — the page does, with the project currency', () => {
    expect(src).not.toMatch(/formatCurrency|Intl\.|\$\{.*\}\s*\$|'\$'/)
  })
})

// ── 12 · Page wiring, roles and isolation (source structure) ─────────────────

describe('ProjectPulse page — role gate, subscriptions, isolation', () => {
  const page = read('pages/project/ProjectPulse.jsx')
  const card = read('pages/project/pulse/IndicatorCard.jsx')
  const code = stripComments(page)
  const cardCode = stripComments(card)
  const workspace = code.slice(code.indexOf('function PulseWorkspace'))
  const wrapper = code.slice(code.indexOf('export default function ProjectPulse'), code.indexOf('function StateCount'))

  it('the wrapper waits for the profile and gates on BOTH role lists before rendering the workspace', () => {
    expect(wrapper).toContain('if (profileLoading)')
    expect(wrapper).toContain("!isFinancialRole(profile?.role) || !canReadProgramme(profile?.role)")
    expect(wrapper).toContain('<PulseWorkspace')
    expect(wrapper).not.toMatch(/use(BudgetLines|PurchaseOrders|ProgressClaims|SupplierInvoices|SupplierCreditNotes|Variations|ForecastLines|ProjectCommercial|SupplierPayments|RetentionReleases|ProjectActivities)\(/)
  })

  it('the two role lists this page relies on are identical (one gate covers every read)', () => {
    expect([...FINANCIAL_ROLES].sort()).toEqual([...PROGRAMME_READ_ROLES].sort())
    expect(FINANCIAL_ROLES).not.toContain('subcontractor')
    expect(FINANCIAL_ROLES).not.toContain('client')
  })

  it('the workspace mounts exactly the eleven PULSE sources, each for the given project, and no other subscription', () => {
    const hooks = [...workspace.matchAll(/\buse([A-Z]\w+)\(([^)]*)\)/g)].map(m => [m[1], m[2]])
    const subs = hooks.filter(([n]) => !['Memo', 'LocalToday'].includes(n))
    expect(subs.map(([n]) => n).sort()).toEqual([
      'BudgetLines', 'ForecastLines', 'ProgressClaims', 'ProjectActivities', 'ProjectCommercial', 'PurchaseOrders',
      'RetentionReleases', 'SupplierCreditNotes', 'SupplierInvoices', 'SupplierPayments', 'Variations',
    ])
    for (const [, arg] of subs) expect(arg).toBe('projectId')
    expect(workspace).not.toMatch(/useCostCodes|useContacts|useProjects\(/)
  })

  it('every source state is passed in the snapshot shape, including activities', () => {
    for (const s of PULSE_SOURCES) {
      expect(workspace).toMatch(new RegExp(`${s}:\\s*\\{ loading: ${s}Loading,\\s*error: ${s}Error \\}`))
    }
  })

  it('the clock is useLocalToday (midnight-advancing, not a subscription) and is passed as now', () => {
    expect(workspace).toContain('const now = useLocalToday()')
    expect(workspace).toMatch(/\bnow,\s*\n\s*currencyCode,/)
  })

  it('consumes no write callback and imports no Firebase', () => {
    for (const f of [code, cardCode]) {
      expect(f).not.toMatch(/from 'firebase/)
      expect(f).not.toMatch(/\b(create|update|upsert|cancel|post|void|approve|submit)[A-Z]\w*\b/)
    }
  })

  it('currency comes from the outlet context (the project\'s resolved currency) — nothing hard-coded', () => {
    expect(wrapper).toContain('const { projectId, currencyCode } = useOutletContext()')
    for (const f of [code, cardCode]) {
      expect(f).not.toMatch(/'AUD'|'\$'|en-AU/)
    }
    expect(cardCode).toContain('formatCurrency(value, currencyCode)')
  })

  it('the project outlet is keyed by project, so a switch remounts PULSE (ADR-44)', () => {
    expect(read('layouts/ProjectDetailLayout.jsx')).toContain('<Outlet key={projectId}')
  })

  it('the route and tab exist, the tab sits after Overview, and the hidden top-level route is a pointer', () => {
    const app = read('App.jsx')
    expect(app).toContain('<Route path="pulse" element={<ProjectPulse />} />')
    expect(app).toContain("import ProjectPulse from './pages/project/ProjectPulse'")
    expect(PROJECT_TABS[0].to).toBe('overview')
    expect(PROJECT_TABS[1]).toEqual({ to: 'pulse', label: 'PULSE', mark: 'pulse' }) // mark: ADR-48
    expect(read('lib/nav.js')).not.toMatch(/to:\s*'\/pulse'/)
    const top = stripComments(read('pages/Pulse.jsx'))
    expect(top).toContain('to="/projects"')
    expect(top).not.toMatch(/Coming Soon|\bAI\b|world-first|patent|\bscor|predict/i)
  })

  it('the page and card compute no figure: role helpers only from the domain modules, no arithmetic on values', () => {
    // The page may import exactly the two role predicates; nothing else from
    // the financial or programme modules, and the card imports only a formatter.
    expect(code).toContain("import { isFinancialRole } from '../../lib/margin'")
    expect(code).toContain("import { canReadProgramme } from '../../lib/projectTimeline'")
    expect(code).not.toMatch(/from '\.\.\/\.\.\/lib\/(forecast|supplierPayments|variations|retention|payments|projectSnapshot)'/)
    expect(cardCode).toContain("import { formatIsoDate } from '../../../lib/projectTimeline'")
    expect(cardCode).not.toMatch(/from '\.\.\/\.\.\/\.\.\/lib\/(margin|forecast|supplierPayments|variations|retention|payments|projectSnapshot)'/)
    for (const f of [code, cardCode]) expect(f).not.toMatch(/\.reduce\(/)
    expect(code).toContain("from '../../lib/pulse'")
  })

  it('no health score, percentage-complete, chart, AI or Coming Soon on the page', () => {
    for (const f of [code, cardCode]) {
      for (const s of ['Coming Soon', 'health score', 'Health Score', 'recharts', 'complete%', '% complete', 'AI ']) {
        expect(f).not.toContain(s)
      }
    }
    // The one legitimate percentage is Forecast Margin %.
    expect(cardCode).toContain("kind: 'percent'")
    expect((cardCode.match(/kind: 'percent'/g) ?? []).length).toBe(1)
  })
})

// ── 13 · Design system and responsive structure ──────────────────────────────

describe('ProjectPulse — design system and responsive structure', () => {
  const files = ['pages/project/ProjectPulse.jsx', 'pages/project/pulse/IndicatorCard.jsx']

  it('Tailwind tokens only: no inline style object, no hex colour', () => {
    for (const f of files) {
      const code = stripComments(read(f))
      expect(code, f).not.toMatch(/style=\{\{/)
      expect(code, f).not.toMatch(/#[0-9a-fA-F]{3,6}\b/)
    }
  })

  it('the state summary reflows 2 → 5 columns; values 2 → 4', () => {
    const page = read('pages/project/ProjectPulse.jsx')
    expect(page).toContain('grid-cols-2 gap-2 sm:grid-cols-5')
    expect(read('pages/project/pulse/IndicatorCard.jsx')).toContain('grid-cols-2 gap-x-4 gap-y-2.5 sm:grid-cols-4')
  })

  it('evidence tables sit inside an overflow-x-auto scroller, never a direct child of Card', () => {
    const card = read('pages/project/pulse/IndicatorCard.jsx')
    const tableAt = card.indexOf('<table')
    const before = card.slice(0, tableAt)
    const lastDiv = before.lastIndexOf('<div className="')
    const cls = before.slice(lastDiv + '<div className="'.length, before.indexOf('"', lastDiv + '<div className="'.length))
    expect(cls).toContain('overflow-x-auto')
    expect(card).not.toContain('hidden md:table')
  })

  it('every interactive control keeps a 44px touch target', () => {
    for (const f of files) {
      const code = stripComments(read(f))
      // Match to the tag's closing `>` — not the `>` of an `=>` inside a handler.
      const controls = [...code.matchAll(/<(Link|button|summary)\b[\s\S]*?(?<!=)>/g)].map(m => m[0])
      expect(controls.length, f).toBeGreaterThan(0)
      for (const c of controls) expect(c, `${f}: ${c.slice(0, 60)}`).toContain('min-h-[44px]')
    }
  })

  it('no-issue indicators are collapsed by default (a <details> without `open`)', () => {
    const page = read('pages/project/ProjectPulse.jsx')
    expect(page).toMatch(/<details className="[^"]*">/)
    expect(page).not.toMatch(/<details[^>]*\bopen\b/)
  })

  it('money on the card goes through formatCurrency with the project currency and renders "—" for null', () => {
    expect(formatCurrency(null, 'AUD')).toBe('—')
    expect(formatCurrency(0, 'AUD')).toBe('$0')
    expect(formatCurrency(2145, 'NZD')).not.toBe(formatCurrency(2145, 'AUD'))
  })
})
