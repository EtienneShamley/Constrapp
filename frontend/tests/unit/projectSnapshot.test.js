import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  projectSnapshot, figureState, displayFigure, compositionLayout, selectSnapshotProjectId,
  FIGURE_STATE, FIGURE_DEPENDENCIES, SNAPSHOT_SOURCES, MARGIN_NOT_ESTABLISHED,
} from '../../src/lib/projectSnapshot'
import { projectForecastTotals, computeMargin } from '../../src/lib/margin'
import { payablesSummary } from '../../src/lib/supplierPayments'
import { releasedByInvoiceId } from '../../src/lib/retention'
import { resolveProjectCurrency } from '../../src/lib/currency'
import { formatCurrency } from '../../src/lib/formatters'
import { projectsListState, projectStatusCounts, PROJECTS_LIST_STATE } from '../../src/lib/projects'

// ── Dashboard Analytics — Project Snapshot (ADR-42) ──────────────────────────
//
// The snapshot must be a COMPOSITION of existing selectors, never a second
// implementation. The invariance block below therefore compares every figure
// against the selector it is meant to carry, on fixtures rich enough that each
// figure is non-zero (so a test cannot pass by both sides being 0).
//
// Structural assertions read SOURCE, not rendered DOM: the unit runner is plain
// Node with no jsdom and no testing-library (the ADR-26 convention).

const read = (rel) =>
  readFileSync(fileURLToPath(new URL(`../../src/${rel}`, import.meta.url)), 'utf8')
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '')

// ── Fixtures ─────────────────────────────────────────────────────────────────

const budgetLines = [
  { id: 'bl1', costCodeId: 'cc1', budgeted: 1000 },
  { id: 'bl2', costCodeId: 'cc2', budgeted: 500 },
]

const purchaseOrders = [
  { id: 'po1', status: 'sent', lineItems: [
    { costCodeId: 'cc1', lineTotal: 800 },
    { costCodeId: 'cc2', lineTotal: 400 },
  ] },
  { id: 'po9', status: 'draft', lineItems: [{ costCodeId: 'cc1', lineTotal: 99999 }] },
]

// A posted, retention-free invoice against po1 (the supplierCreditNotes.test.js
// shape, so the credit note below passes the central validity gate).
const inv1 = {
  id: 'inv1', invoiceNumber: 'SI-0001', supplierInvoiceNumber: 'INV-100',
  status: 'posted', supplierId: 'sup1', supplierName: 'Ace Concrete', currency: 'AUD',
  poId: 'po1',
  lineItems: [
    { poLineIndex: 0, costCodeId: 'cc1', costCodeName: '03-100 — Concrete', description: 'Slab', amount: 600, taxCode: 'gst', gstAmount: 60 },
    { poLineIndex: 1, costCodeId: 'cc2', costCodeName: '03-200 — Formwork', description: 'Forms', amount: 400, taxCode: 'gst', gstAmount: 40 },
  ],
  retention: 0, retentionGst: 0, retentionTotal: 0,
  subtotal: 1000, gstTotal: 100, grossTotal: 1100,
  net: 1000, payableGst: 100, payableTotal: 1100,
  dueDate: '2026-01-31',
}

// A posted invoice with retention held, partly released below.
const inv2 = {
  id: 'inv2', invoiceNumber: 'SI-0002', supplierInvoiceNumber: 'INV-200',
  status: 'posted', supplierId: 'sup2', supplierName: 'Beta Steel', currency: 'AUD',
  lineItems: [
    { costCodeId: 'cc3', costCodeName: '05-100 — Steel', description: 'Steel', amount: 1000, taxCode: 'gst', gstAmount: 100 },
  ],
  retention: 100, retentionGst: 10, retentionTotal: 110,
  subtotal: 1000, gstTotal: 100, grossTotal: 1100,
  net: 900, payableGst: 90, payableTotal: 990,
  dueDate: '2026-02-28',
}

const supplierInvoices = [inv1, inv2, { ...inv2, id: 'inv3', status: 'draft' }]

const progressClaims = [
  { id: 'cl1', status: 'approved', poId: 'po2', lineItems: [{ costCodeId: 'cc4', approvedThisPeriod: 250 }] },
  { id: 'cl2', status: 'submitted', poId: 'po2', lineItems: [{ costCodeId: 'cc4', approvedThisPeriod: 7777 }] },
]

const supplierCreditNotes = [{
  id: 'cn1', creditNumber: 'SCN-0001', status: 'posted', docType: 'credit_note',
  supplierInvoiceId: 'inv1', invoiceNumber: 'SI-0001', supplierInvoiceNumber: 'INV-100',
  supplierId: 'sup1', supplierName: 'Ace Concrete', supplierCreditReference: 'CN-9',
  creditDate: '2026-02-01', reason: 'Over-claimed quantities',
  lineItems: [
    { costCodeId: 'cc1', costCodeName: '03-100 — Concrete', description: 'Credit', amount: 100, taxCode: 'gst', gstAmount: 10 },
  ],
  subtotal: 100, gstTotal: 10, grossTotal: 110, currency: 'AUD',
}]

const variations = [
  { id: 'v1', variationType: 'client', status: 'approved', approvedSubtotal: 2000, lineItems: [] },
  { id: 'v2', variationType: 'supplier', status: 'approved', approvedSubtotal: 50,
    lineItems: [{ costCodeId: 'cc1', approvedAmount: 50 }] },
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
}]

const retentionReleases = [
  { id: 'rr1', status: 'posted', supplierInvoiceId: 'inv2', amount: 50, gstAmount: 5, releaseTotal: 55 },
  { id: 'rr2', status: 'draft', supplierInvoiceId: 'inv2', amount: 50, gstAmount: 5, releaseTotal: 55 },
]

const SOURCES = {
  budgetLines, purchaseOrders, progressClaims, supplierInvoices, supplierCreditNotes,
  variations, forecastLines, baseline, supplierPayments, retentionReleases,
}

const settledStates = (over = {}) => ({
  ...Object.fromEntries(SNAPSHOT_SOURCES.map(s => [s, { loading: false, error: false }])),
  ...over,
})

const snap = (sources = SOURCES, sourceStates = settledStates(), currencyCode = 'AUD') =>
  projectSnapshot({ sources, sourceStates, currencyCode })

// The selectors the snapshot is meant to carry, called directly.
const directTotals = projectForecastTotals({
  budgetLines, purchaseOrders, progressClaims, supplierInvoices, supplierCreditNotes, variations, forecastLines,
})
const directMargin = computeMargin({ baseline, variations, forecastFinalCost: directTotals.forecastFinalCost })
const directPayables = payablesSummary(
  supplierInvoices, supplierPayments, supplierCreditNotes, releasedByInvoiceId(retentionReleases),
)

// ── Invariance ───────────────────────────────────────────────────────────────

describe('invariance: every snapshot figure IS the existing selector output', () => {
  const s = snap()

  it('the fixtures exercise every figure (no 0 === 0 passes)', () => {
    for (const v of [
      directTotals.budgeted, directTotals.actual, directTotals.remainingCommitted,
      directTotals.forecastFinalCost, directTotals.varianceToBudget, directTotals.uncommittedCostToComplete,
      directMargin.forecastGrossProfit, directMargin.forecastMarginPct, directPayables.remaining,
    ]) {
      expect(v).not.toBe(0)
      expect(v).not.toBeNull()
    }
  })

  it('the five forecast figures are the literal values they were before ADR-43 (regression pin)', () => {
    // Hand-derived from the fixtures above: cc1 actual 600 − 100 credit = 500,
    // cc2 400, cc3 1000, cc4 claim 250 → Actual 2150; cc1 PO 800 − 600 invoiced
    // → Remaining Committed 200; CTC 150; FFC 2500; budget 1500 → variance −1000.
    // The composer change (ADR-43) added flags and counts to this path and may
    // move NO money figure the Dashboard shows.
    expect(s.approvedBudget.value).toBe(1500)
    expect(s.actual.value).toBe(2150)
    expect(s.remainingCommitted.value).toBe(200)
    expect(s.forecastFinalCost.value).toBe(2500)
    expect(s.varianceToBudget.value).toBe(-1000)
    expect(s.costComposition.uncommittedCostToComplete).toBe(150)
  })

  it('the fixtures exercise credit notes and released retention (both move a figure)', () => {
    const noCredits = snap({ ...SOURCES, supplierCreditNotes: [] })
    expect(noCredits.actual.value).not.toBe(s.actual.value)
    expect(noCredits.remainingPayable.value).not.toBe(s.remainingPayable.value)
    const noReleases = snap({ ...SOURCES, retentionReleases: [] })
    expect(noReleases.remainingPayable.value).not.toBe(s.remainingPayable.value)
  })

  it('Approved Budget equals projectForecastTotals().budgeted', () => {
    expect(s.approvedBudget.state).toBe(FIGURE_STATE.READY)
    expect(s.approvedBudget.value).toBe(directTotals.budgeted)
  })

  it('Actual equals the forecast rollup', () => {
    expect(s.actual.value).toBe(directTotals.actual)
  })

  it('Remaining Committed equals the forecast rollup', () => {
    expect(s.remainingCommitted.value).toBe(directTotals.remainingCommitted)
  })

  it('Forecast Final Cost equals projectForecastTotals().forecastFinalCost', () => {
    expect(s.forecastFinalCost.value).toBe(directTotals.forecastFinalCost)
  })

  it('Variance to Budget equals the forecast rollup', () => {
    expect(s.varianceToBudget.value).toBe(directTotals.varianceToBudget)
  })

  it('Gross Profit and Margin % equal computeMargin', () => {
    expect(s.margin.state).toBe(FIGURE_STATE.READY)
    expect(s.margin.grossProfit).toBe(directMargin.forecastGrossProfit)
    expect(s.margin.marginPct).toBe(directMargin.forecastMarginPct)
  })

  it('Remaining Payable equals payablesSummary().remaining (with released retention)', () => {
    expect(s.remainingPayable.value).toBe(directPayables.remaining)
  })

  it('the composition segments and totals are the rollup outputs, unchanged', () => {
    expect(s.costComposition.actual).toBe(directTotals.actual)
    expect(s.costComposition.remainingCommitted).toBe(directTotals.remainingCommitted)
    expect(s.costComposition.uncommittedCostToComplete).toBe(directTotals.uncommittedCostToComplete)
    expect(s.costComposition.forecastFinalCost).toBe(directTotals.forecastFinalCost)
    expect(s.costComposition.approvedBudget).toBe(directTotals.budgeted)
  })

  it('cost codes change no amount — the snapshot does not need them', () => {
    const withNames = projectForecastTotals({
      costCodes: [{ id: 'cc1', code: '03-100', name: 'Concrete', isActive: true }],
      budgetLines, purchaseOrders, progressClaims, supplierInvoices, supplierCreditNotes, variations, forecastLines,
    })
    for (const k of ['budgeted', 'actual', 'remainingCommitted', 'forecastFinalCost', 'varianceToBudget', 'uncommittedCostToComplete']) {
      expect(withNames[k]).toBe(directTotals[k])
    }
  })
})

// ── Availability ─────────────────────────────────────────────────────────────

const FIGURES = ['approvedBudget', 'actual', 'remainingCommitted', 'forecastFinalCost', 'varianceToBudget', 'remainingPayable']
const money = (n) => formatCurrency(n, 'AUD')

describe('availability: loading → "—", failed → Unavailable, settled → value', () => {
  for (const key of FIGURES) {
    for (const dep of FIGURE_DEPENDENCIES[key]) {
      it(`${key}: ${dep} loading renders "—" and carries no value`, () => {
        const f = snap(SOURCES, settledStates({ [dep]: { loading: true, error: false } }))[key]
        expect(f.state).toBe(FIGURE_STATE.LOADING)
        expect(f.value).toBeNull()
        expect(displayFigure(f, money)).toBe('—')
      })

      it(`${key}: ${dep} failed renders Unavailable and names the source`, () => {
        const f = snap(SOURCES, settledStates({ [dep]: { loading: false, error: true } }))[key]
        expect(f.state).toBe(FIGURE_STATE.UNAVAILABLE)
        expect(f.value).toBeNull()
        expect(f.failedSources).toContain(dep)
        expect(displayFigure(f, money)).toBe('Unavailable')
      })
    }
  }

  it('margin follows its dependencies too (loading / failed)', () => {
    for (const dep of FIGURE_DEPENDENCIES.margin) {
      const loading = snap(SOURCES, settledStates({ [dep]: { loading: true, error: false } })).margin
      expect(loading.state).toBe(FIGURE_STATE.LOADING)
      expect(loading.grossProfit).toBeNull()
      const failed = snap(SOURCES, settledStates({ [dep]: { loading: false, error: true } })).margin
      expect(failed.state).toBe(FIGURE_STATE.UNAVAILABLE)
      expect(failed.grossProfit).toBeNull()
    }
  })

  it('a failed source never hides a figure that does not depend on it', () => {
    for (const source of SNAPSHOT_SOURCES) {
      const s = snap(SOURCES, settledStates({ [source]: { loading: false, error: true } }))
      for (const key of FIGURES) {
        if (FIGURE_DEPENDENCIES[key].includes(source)) continue
        expect(s[key].state, `${source} failing must not hide ${key}`).toBe(FIGURE_STATE.READY)
      }
    }
  })

  it('specifically: a payments failure leaves every cost figure ready', () => {
    const s = snap(SOURCES, settledStates({ supplierPayments: { loading: false, error: true } }))
    expect(s.remainingPayable.state).toBe(FIGURE_STATE.UNAVAILABLE)
    expect(s.forecastFinalCost.state).toBe(FIGURE_STATE.READY)
    expect(s.approvedBudget.state).toBe(FIGURE_STATE.READY)
  })

  it('a failure outranks loading', () => {
    const r = figureState(['a', 'b'], { a: { loading: true, error: false }, b: { loading: false, error: true } })
    expect(r.state).toBe(FIGURE_STATE.UNAVAILABLE)
    expect(r.failedSources).toEqual(['b'])
  })

  it('missing or malformed error information is never treated as success', () => {
    expect(figureState(['a'], {}).state).toBe(FIGURE_STATE.UNAVAILABLE)
    expect(figureState(['a'], { a: { loading: false } }).state).toBe(FIGURE_STATE.UNAVAILABLE)
    expect(figureState(['a'], { a: { loading: false, error: undefined } }).state).toBe(FIGURE_STATE.UNAVAILABLE)
    expect(snap(SOURCES, {}).forecastFinalCost.state).toBe(FIGURE_STATE.UNAVAILABLE)
  })

  it('a settled genuine zero renders as a real zero', () => {
    const empty = snap({}, settledStates())
    for (const key of FIGURES) {
      expect(empty[key].state).toBe(FIGURE_STATE.READY)
      expect(empty[key].value).toBe(0)
      expect(displayFigure(empty[key], money)).toBe(formatCurrency(0, 'AUD'))
    }
  })
})

// ── Baseline ─────────────────────────────────────────────────────────────────

describe('baseline: an unset contract value is never a zero margin', () => {
  it('settled, no baseline → not established, no profit or margin value', () => {
    const m = snap({ ...SOURCES, baseline: null }).margin
    expect(m.state).toBe(MARGIN_NOT_ESTABLISHED)
    expect(m.grossProfit).toBeNull()
    expect(m.marginPct).toBeNull()
  })

  it('a baseline with no Original Contract Value is not established either', () => {
    expect(snap({ ...SOURCES, baseline: { originalApprovedBudget: 100 } }).margin.state).toBe(MARGIN_NOT_ESTABLISHED)
  })

  it('baseline still loading → loading, not "not established"', () => {
    const m = snap({ ...SOURCES, baseline: null }, settledStates({ baseline: { loading: true, error: false } })).margin
    expect(m.state).toBe(FIGURE_STATE.LOADING)
  })

  it('baseline read failed → unavailable, not "not established"', () => {
    const m = snap({ ...SOURCES, baseline: null }, settledStates({ baseline: { loading: false, error: true } })).margin
    expect(m.state).toBe(FIGURE_STATE.UNAVAILABLE)
  })

  it('established with zero revenue keeps computeMargin\'s null margin %', () => {
    const m = snap({ ...SOURCES, baseline: { originalContractValue: 0 }, variations: [] }).margin
    expect(m.state).toBe(FIGURE_STATE.READY)
    expect(m.marginPct).toBeNull()
  })
})

// ── Currency ─────────────────────────────────────────────────────────────────

describe('currency: one project, one resolved currency, no aggregation', () => {
  it('carries the selected project\'s resolved currency', () => {
    const company = { baseCurrency: 'AUD' }
    const nzd = { id: 'p2', currency: 'NZD' }
    const code = resolveProjectCurrency(nzd, company)
    expect(code).toBe('NZD')
    expect(snap(SOURCES, settledStates(), code).currencyCode).toBe('NZD')
  })

  it('the snapshot module offers no portfolio aggregation', () => {
    const code = stripComments(read('lib/projectSnapshot.js'))
    expect(code).not.toMatch(/\.reduce\(/)
    expect(code).not.toMatch(/projects\.(map|forEach|reduce)\(/)
    expect(code).not.toContain('roundMoney')
  })

  it('the Dashboard sums no money across projects', () => {
    const code = stripComments(read('pages/Dashboard.jsx'))
    expect(code).not.toMatch(/\.reduce\(/)
    expect(code).not.toContain('baseCurrency')
  })
})

// ── Cost composition geometry ────────────────────────────────────────────────

describe('compositionLayout: honest proportions, no division errors', () => {
  const base = { actual: 400, remainingCommitted: 300, uncommittedCostToComplete: 300, forecastFinalCost: 1000 }

  it('FFC of zero is not drawn', () => {
    const l = compositionLayout({ actual: 0, remainingCommitted: 0, uncommittedCostToComplete: 0, forecastFinalCost: 0, approvedBudget: 0 })
    expect(l.drawable).toBe(false)
    expect(l.reason).toBe('no_forecast_cost')
  })

  it('FFC of zero with a budget is still not drawn (no NaN, no fake bar)', () => {
    const l = compositionLayout({ actual: 0, remainingCommitted: 0, uncommittedCostToComplete: 0, forecastFinalCost: 0, approvedBudget: 500 })
    expect(l.drawable).toBe(false)
  })

  it('a negative component is never drawn to scale', () => {
    const l = compositionLayout({ ...base, actual: -50, forecastFinalCost: 550, approvedBudget: 1000 })
    expect(l.drawable).toBe(false)
    expect(l.reason).toBe('negative')
  })

  it('over budget: the bar spans FFC and the budget marker sits inside it', () => {
    const l = compositionLayout({ ...base, approvedBudget: 800 })
    expect(l.drawable).toBe(true)
    expect(l.budgetMarkerPct).toBe(80)
    expect(l.segments.map(s => s.widthPct)).toEqual([40, 30, 30])
  })

  it('under budget: the bar is scaled to the budget, marker at the end', () => {
    const l = compositionLayout({ ...base, approvedBudget: 2000 })
    expect(l.budgetMarkerPct).toBe(100)
    expect(l.segments.map(s => s.widthPct)).toEqual([20, 15, 15])
  })

  it('zero approved budget: no marker, no division by zero', () => {
    const l = compositionLayout({ ...base, approvedBudget: 0 })
    expect(l.drawable).toBe(true)
    expect(l.budgetMarkerPct).toBeNull()
    for (const s of l.segments) expect(Number.isFinite(s.widthPct)).toBe(true)
  })

  it('cent-level rounding can never push the bar past 100%', () => {
    const l = compositionLayout({ actual: 333.34, remainingCommitted: 333.34, uncommittedCostToComplete: 333.34, forecastFinalCost: 1000, approvedBudget: 0 })
    const last = l.segments[l.segments.length - 1]
    expect(last.offsetPct + last.widthPct).toBeLessThanOrEqual(100)
  })

  it('segments carry the selector values unchanged', () => {
    const l = compositionLayout({ ...base, approvedBudget: 0 })
    expect(l.segments.map(s => s.value)).toEqual([400, 300, 300])
  })
})

// ── Project selection ────────────────────────────────────────────────────────

describe('selectSnapshotProjectId: URL first, then the existing order', () => {
  const projects = [
    { id: 'a', status: 'Planning' },
    { id: 'b', status: 'In Progress' },
    { id: 'c', status: 'In Progress' },
  ]

  it('a valid URL id wins', () => {
    expect(selectSnapshotProjectId(projects, 'c')).toBe('c')
  })

  it('an unknown id falls back to the first In Progress project in list order', () => {
    expect(selectSnapshotProjectId(projects, 'zzz')).toBe('b')
    expect(selectSnapshotProjectId(projects, null)).toBe('b')
  })

  it('with no In Progress project, the first project', () => {
    expect(selectSnapshotProjectId([{ id: 'x', status: 'Completed' }, { id: 'y', status: 'On Hold' }], null)).toBe('x')
  })

  it('no projects → no selection', () => {
    expect(selectSnapshotProjectId([], 'a')).toBeNull()
    expect(selectSnapshotProjectId(undefined, null)).toBeNull()
  })
})

// ── Projects register state (projectsError) ──────────────────────────────────

describe('the project register keeps loading, unavailable and empty distinct', () => {
  it('derives each state', () => {
    expect(projectsListState({ loading: true, error: false, count: 0 })).toBe(PROJECTS_LIST_STATE.LOADING)
    expect(projectsListState({ loading: false, error: true, count: 0 })).toBe(PROJECTS_LIST_STATE.UNAVAILABLE)
    expect(projectsListState({ loading: false, error: false, count: 0 })).toBe(PROJECTS_LIST_STATE.EMPTY)
    expect(projectsListState({ loading: false, error: false, count: 3 })).toBe(PROJECTS_LIST_STATE.READY)
  })

  it('useProjects exposes projectsError (settled-only), additively', () => {
    const code = stripComments(read('hooks/useProjects.jsx'))
    expect(code).toContain('const projectsError = settled ? snap.error : false')
    expect(code).toMatch(/value=\{\{ projects, projectsLoading, projectsError, createProject, updateProject, updateProjectCurrency, lockProjectCurrency \}\}/)
  })

  // Dashboard v2 (ADR-45): the register moved into its own component; the
  // Dashboard still passes it the projectsError-derived list state.
  it('the Dashboard checks UNAVAILABLE before it can say "No projects yet"', () => {
    expect(stripComments(read('pages/Dashboard.jsx'))).toContain('projectsError')
    expect(stripComments(read('pages/Dashboard.jsx'))).toContain('listState={portfolio.listState}')
    const code = stripComments(read('pages/dashboard/ProjectRegister.jsx'))
    const unavailableAt = code.indexOf('PROJECTS_LIST_STATE.UNAVAILABLE ?')
    const emptyAt = code.indexOf('PROJECTS_LIST_STATE.EMPTY ?')
    expect(unavailableAt).toBeGreaterThan(-1)
    expect(emptyAt).toBeGreaterThan(unavailableAt)
    expect(code).toContain('Projects unavailable')
  })

  it('status counts follow PROJECT_STATUSES and always sum to the total', () => {
    const c = projectStatusCounts([
      { status: 'Planning' }, { status: 'In Progress' }, { status: 'In Progress' }, { status: 'Legacy' },
    ])
    expect(c.byStatus.map(s => s.status)).toEqual(['Planning', 'In Progress', 'Backlogged', 'On Hold', 'Completed'])
    expect(c.byStatus.find(s => s.status === 'In Progress').count).toBe(2)
    expect(c.other).toBe(1)
    expect(c.byStatus.reduce((n, s) => n + s.count, 0) + c.other).toBe(4)
  })
})

// ── Structure ────────────────────────────────────────────────────────────────

const FINANCIAL_HOOKS = [
  'useBudgetLines', 'usePurchaseOrders', 'useProgressClaims', 'useSupplierInvoices',
  'useSupplierCreditNotes', 'useVariations', 'useForecastLines', 'useProjectCommercial',
  'useSupplierPayments', 'useRetentionReleases',
]

describe('structure: role gate, no arithmetic, no writes, no chart library', () => {
  const dashboard = stripComments(read('pages/Dashboard.jsx'))
  const snapshotPage = stripComments(read('pages/dashboard/ProjectSnapshot.jsx'))
  const snapshotLib = stripComments(read('lib/projectSnapshot.js'))

  it('the Dashboard mounts no financial hook itself', () => {
    for (const h of FINANCIAL_HOOKS) expect(dashboard).not.toContain(h)
  })

  it('the snapshot child mounts every financial hook it reads', () => {
    for (const h of FINANCIAL_HOOKS) expect(snapshotPage).toContain(`${h}(projectId)`)
  })

  it('the child is rendered only behind the financial-role gate', () => {
    expect(dashboard).toContain('const canViewSnapshot = isFinancialRole(profile?.role)')
    const gate = dashboard.indexOf('{canViewSnapshot && selectedProject && (')
    const child = dashboard.indexOf('<ProjectSnapshot')
    expect(gate).toBeGreaterThan(-1)
    expect(child).toBeGreaterThan(gate)
    expect(dashboard.match(/<ProjectSnapshot\b/g)).toHaveLength(1)
  })

  it('the child is keyed by project, so a switch never shows the previous figures', () => {
    expect(dashboard).toContain('key={selectedProject.id}')
  })

  it('no write callback is consumed', () => {
    expect(snapshotPage).not.toMatch(/\b(create|update|upsert|post|void|transition|save)[A-Z]\w*/)
    expect(dashboard).not.toMatch(/\b(createProject|updateProject|updateProjectCurrency|lockProjectCurrency)\b/)
  })

  it('no financial arithmetic on either page: they import no financial selector', () => {
    for (const lib of ['lib/forecast', 'lib/purchaseOrders', 'lib/progressClaims', 'lib/supplierInvoices',
      'lib/supplierCreditNotes', 'lib/supplierPayments', 'lib/variations', 'lib/retention', 'lib/cashFlow']) {
      expect(dashboard).not.toContain(lib)
      expect(snapshotPage).not.toContain(lib)
    }
    // The Dashboard may use lib/margin.js for the role helper ONLY.
    expect(dashboard).toMatch(/import \{ isFinancialRole \} from '\.\.\/lib\/margin'/)
    expect(snapshotPage).not.toContain('lib/margin')
    for (const code of [dashboard, snapshotPage]) {
      expect(code).not.toMatch(/\.reduce\(/)
      expect(code).not.toContain('roundMoney')
    }
  })

  it('the composition module imports only the selectors it carries', () => {
    const imports = [...snapshotLib.matchAll(/^import \{([^}]*)\} from '([^']+)'/gm)]
      .map(([, names, from]) => `${from}:${names.replace(/\s+/g, '')}`)
    expect(imports.sort()).toEqual([
      './margin:projectForecastTotals,computeMargin,isBaselineEstablished',
      './retention:releasedByInvoiceId',
      './supplierPayments:payablesSummary',
    ])
  })

  it('the forecast counts (unforecastedCount / overBudgetCount) are not consumed — Cash Flow owns them (ADR-43)', () => {
    for (const code of [dashboard, snapshotPage, snapshotLib]) {
      expect(code).not.toContain('unforecastedCount')
      expect(code).not.toContain('overBudgetCount')
    }
  })

  it('no chart library and no Firebase import', () => {
    for (const code of [dashboard, snapshotPage, snapshotLib]) {
      expect(code).not.toContain('recharts')
      expect(code).not.toContain('firebase/')
    }
  })

  // Dashboard v2 (ADR-45): the register lives in pages/dashboard/ProjectRegister.jsx.
  const register = stripComments(read('pages/dashboard/ProjectRegister.jsx'))

  it('the project table keeps its horizontal-overflow protection', () => {
    const at = register.indexOf('<table')
    expect(register.lastIndexOf('<div className="hidden lg:block overflow-x-auto', at)).toBeGreaterThan(-1)
    expect(register).toMatch(/<table className="[^"]*min-w-\[\d+px\]/)
  })

  it('the table labels the headline budget honestly and adds no financial column', () => {
    expect(register).toContain("'Headline Budget'")
    expect(register).not.toContain("'Budget',")
    for (const code of [register, dashboard]) {
      for (const h of ['Approved Budget', 'Forecast Final Cost', 'Margin']) {
        expect(code).not.toContain(`'${h}'`)
      }
    }
  })
})
