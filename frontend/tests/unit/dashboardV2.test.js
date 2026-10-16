import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  projectSnapshot, performanceLayout, figureState, displayFigure,
  FIGURE_STATE, FIGURE_DEPENDENCIES, SNAPSHOT_SOURCES, MARGIN_NOT_ESTABLISHED, CONTRACT_ROW_STATE,
} from '../../src/lib/projectSnapshot'
import { projectForecastTotals, computeMargin, isFinancialRole } from '../../src/lib/margin'
import { timelineSummary, canReadProgramme } from '../../src/lib/projectTimeline'
import { programmeOverview, activityStatusCounts, donutSegments } from '../../src/lib/dashboardProgramme'
import { portfolioSummary, statusBarSegments, PROJECTS_LIST_STATE } from '../../src/lib/projects'
import { formatCurrency } from '../../src/lib/formatters'

// ── Premium Dashboard v2 (ADR-45) ────────────────────────────────────────────
//
// v2 is a PRESENTATION change over ADR-42's composition. These tests pin that:
//   1. every new figure IS an existing selector output (computeMargin /
//      projectForecastTotals), with per-figure availability;
//   2. chart and donut geometry is honest (one scale, nothing drawn from a
//      loading or failed cost source, negatives never drawn to scale);
//   3. programme figures ARE timelineSummary, with no completion percentage;
//   4. portfolio counts are never a false zero while loading or after a failure;
//   5. structure — role gates, keyed children, no writes, no money arithmetic,
//      no chart library, tokens only, responsive breakpoints.
// Structural assertions read SOURCE: the unit runner is plain Node with no
// jsdom (the ADR-26 convention).

const read = (rel) =>
  readFileSync(fileURLToPath(new URL(`../../src/${rel}`, import.meta.url)), 'utf8')
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '')

const DASHBOARD_DIR = fileURLToPath(new URL('../../src/pages/dashboard/', import.meta.url))
const DASHBOARD_FILES = [
  'pages/Dashboard.jsx',
  ...readdirSync(DASHBOARD_DIR).filter(f => f.endsWith('.jsx')).map(f => `pages/dashboard/${f}`),
]

// ── Fixtures ─────────────────────────────────────────────────────────────────

const SOURCES = {
  budgetLines: [
    { id: 'bl1', costCodeId: 'cc1', budgeted: 1000 },
    { id: 'bl2', costCodeId: 'cc2', budgeted: 500 },
  ],
  purchaseOrders: [
    { id: 'po1', status: 'sent', lineItems: [
      { costCodeId: 'cc1', lineTotal: 800 },
      { costCodeId: 'cc2', lineTotal: 400 },
    ] },
  ],
  progressClaims: [
    { id: 'cl1', status: 'approved', poId: 'po2', lineItems: [{ costCodeId: 'cc4', approvedThisPeriod: 250 }] },
  ],
  supplierInvoices: [],
  supplierCreditNotes: [],
  variations: [
    { id: 'v1', variationType: 'client', status: 'approved', approvedSubtotal: 2000, lineItems: [] },
  ],
  forecastLines: [
    { id: 'cc1', costCodeId: 'cc1', uncommittedCostToComplete: 150 },
    { id: 'cc8', costCodeId: 'cc8', uncommittedCostToComplete: 40 },
  ],
  baseline: { originalContractValue: 10000, originalApprovedBudget: 1500 },
  supplierPayments: [],
  retentionReleases: [],
}

const settled = (over = {}) => ({
  ...Object.fromEntries(SNAPSHOT_SOURCES.map(s => [s, { loading: false, error: false }])),
  ...over,
})
const snap = (sources = SOURCES, sourceStates = settled(), currencyCode = 'AUD') =>
  projectSnapshot({ sources, sourceStates, currencyCode })

const { baseline } = SOURCES
const totals = projectForecastTotals({
  budgetLines: SOURCES.budgetLines, purchaseOrders: SOURCES.purchaseOrders, progressClaims: SOURCES.progressClaims,
  supplierInvoices: SOURCES.supplierInvoices, supplierCreditNotes: SOURCES.supplierCreditNotes,
  variations: SOURCES.variations, forecastLines: SOURCES.forecastLines,
})
const margin = computeMargin({ baseline, variations: SOURCES.variations, forecastFinalCost: totals.forecastFinalCost })

// ── 1. New figures are the existing selector outputs ─────────────────────────

describe('v2 figures ARE existing selector outputs (no new arithmetic)', () => {
  it('the fixtures exercise every new figure (no 0 === 0 passes)', () => {
    expect(totals.uncommittedCostToComplete).not.toBe(0)
    expect(margin.currentContractSum).not.toBe(0)
    expect(margin.marginMovement).not.toBe(0)
    expect(margin.marginMovement).not.toBeNull()
  })

  it('Uncommitted Cost to Complete equals projectForecastTotals().uncommittedCostToComplete', () => {
    expect(snap().uncommittedCostToComplete.value).toBe(totals.uncommittedCostToComplete)
  })

  it('Current Contract Sum equals computeMargin().currentContractSum', () => {
    expect(snap().currentContractSum.value).toBe(margin.currentContractSum)
  })

  it('Margin Movement equals computeMargin().marginMovement, flagged as planned', () => {
    const m = snap().marginMovement
    expect(m.value).toBe(margin.marginMovement)
    expect(m.planned).toBe(true)
  })

  it('the original ADR-42 figures are unchanged by v2', () => {
    const s = snap()
    expect(s.approvedBudget.value).toBe(totals.budgeted)
    expect(s.actual.value).toBe(totals.actual)
    expect(s.remainingCommitted.value).toBe(totals.remainingCommitted)
    expect(s.forecastFinalCost.value).toBe(totals.forecastFinalCost)
    expect(s.varianceToBudget.value).toBe(totals.varianceToBudget)
    expect(s.margin.grossProfit).toBe(margin.forecastGrossProfit)
    expect(s.margin.marginPct).toBe(margin.forecastMarginPct)
  })

  it('Uncommitted CTC depends on forecast lines only (perturbation-verified in financialReliability)', () => {
    expect(FIGURE_DEPENDENCIES.uncommittedCostToComplete).toEqual(['forecastLines'])
  })
})

describe('v2 figures: loading → "—", failed → Unavailable, settled zero → $0', () => {
  const money = (n) => formatCurrency(n, 'AUD')

  for (const key of ['uncommittedCostToComplete', 'currentContractSum', 'marginMovement']) {
    const deps = FIGURE_DEPENDENCIES[key]
    for (const dep of deps) {
      it(`${key}: ${dep} loading → "—", no value`, () => {
        const f = snap(SOURCES, settled({ [dep]: { loading: true, error: false } }))[key]
        expect(f.state).toBe(FIGURE_STATE.LOADING)
        expect(f.value).toBeNull()
        expect(displayFigure(f, money)).toBe('—')
      })
      it(`${key}: ${dep} failed → Unavailable naming it`, () => {
        const f = snap(SOURCES, settled({ [dep]: { loading: false, error: true } }))[key]
        expect(f.state).toBe(FIGURE_STATE.UNAVAILABLE)
        expect(f.failedSources).toContain(dep)
        expect(f.value).toBeNull()
      })
    }
  }

  it('a settled project with no forecast lines shows a genuine $0 uncommitted CTC', () => {
    const f = snap({ ...SOURCES, forecastLines: [] }).uncommittedCostToComplete
    expect(f.state).toBe(FIGURE_STATE.READY)
    expect(f.value).toBe(0)
    expect(displayFigure(f, money)).toBe(money(0))
  })
})

describe('missing baseline: contract and movement are "not established", never $0', () => {
  it('no baseline document → not established, no values', () => {
    const s = snap({ ...SOURCES, baseline: null })
    expect(s.currentContractSum.state).toBe(MARGIN_NOT_ESTABLISHED)
    expect(s.currentContractSum.value).toBeNull()
    expect(s.marginMovement.state).toBe(MARGIN_NOT_ESTABLISHED)
    expect(s.marginMovement.value).toBeNull()
    expect(s.marginMovement.planned).toBe(false)
  })

  it('baseline still loading → loading, not "not established"', () => {
    const s = snap({ ...SOURCES, baseline: null }, settled({ baseline: { loading: true, error: false } }))
    expect(s.currentContractSum.state).toBe(FIGURE_STATE.LOADING)
  })

  it('baseline read failed → unavailable, not "not established"', () => {
    const s = snap({ ...SOURCES, baseline: null }, settled({ baseline: { loading: false, error: true } }))
    expect(s.currentContractSum.state).toBe(FIGURE_STATE.UNAVAILABLE)
    expect(s.marginMovement.state).toBe(FIGURE_STATE.UNAVAILABLE)
  })

  it('no Original Approved Budget → movement ready but NOT planned (no movement shown)', () => {
    const s = snap({ ...SOURCES, baseline: { originalContractValue: 10000, originalApprovedBudget: null } })
    expect(s.marginMovement.state).toBe(FIGURE_STATE.READY)
    expect(s.marginMovement.planned).toBe(false)
    expect(s.marginMovement.value).toBeNull()
  })
})

// ── 2. Chart geometry ────────────────────────────────────────────────────────

const ready = (value) => ({ state: FIGURE_STATE.READY, failedSources: [], value })
const comp = (over = {}) => ({
  state: FIGURE_STATE.READY, failedSources: [],
  actual: 400, remainingCommitted: 300, uncommittedCostToComplete: 100,
  forecastFinalCost: 800, approvedBudget: 1000, ...over,
})

describe('performanceLayout: one honest scale', () => {
  it('the real snapshot lays out with every bar and carries selector values unchanged', () => {
    const s = snap()
    const l = performanceLayout(s)
    expect(l.state).toBe(FIGURE_STATE.READY)
    expect(l.drawable).toBe(true)
    expect(l.contract.value).toBe(margin.currentContractSum)
    expect(l.budget.value).toBe(totals.budgeted)
    expect(l.cost.value).toBe(totals.forecastFinalCost)
    expect(l.segments.map(x => x.value)).toEqual([totals.actual, totals.remainingCommitted, totals.uncommittedCostToComplete])
  })

  it('scale is the largest value; the largest bar spans 100%', () => {
    const l = performanceLayout({ costComposition: comp(), currentContractSum: ready(2000) })
    expect(l.scale).toBe(2000)
    expect(l.contract.widthPct).toBe(100)
    expect(l.budget.widthPct).toBe(50)
    expect(l.cost.widthPct).toBe(40)
    expect(l.segments.map(s => s.widthPct)).toEqual([20, 15, 5])
    expect(l.segments.map(s => s.offsetPct)).toEqual([0, 20, 35])
    expect(l.budgetMarkerPct).toBe(50)
  })

  it('over budget: the cost bar spans the scale and the budget marker sits inside it', () => {
    const l = performanceLayout({ costComposition: comp({ forecastFinalCost: 1250, actual: 800, remainingCommitted: 350 }), currentContractSum: ready(1000) })
    expect(l.scale).toBe(1250)
    expect(l.cost.widthPct).toBe(100)
    expect(l.budgetMarkerPct).toBe(80)
  })

  it('cent-level rounding never pushes the cost bar past 100%', () => {
    const l = performanceLayout({
      costComposition: comp({ actual: 400.01, remainingCommitted: 300, uncommittedCostToComplete: 100, forecastFinalCost: 800, approvedBudget: 0 }),
      currentContractSum: ready(0.5),
    })
    const end = l.segments[2].offsetPct + l.segments[2].widthPct
    expect(end).toBeLessThanOrEqual(100)
  })

  it('cost source loading → LOADING; nothing drawn', () => {
    const l = performanceLayout({ costComposition: { state: FIGURE_STATE.LOADING, failedSources: [] }, currentContractSum: ready(1) })
    expect(l.state).toBe(FIGURE_STATE.LOADING)
    expect(l.drawable).toBe(false)
    expect(l.segments).toEqual([])
  })

  it('contract still loading → LOADING (the scale is not final yet)', () => {
    const l = performanceLayout({ costComposition: comp(), currentContractSum: { state: FIGURE_STATE.LOADING, failedSources: [], value: null } })
    expect(l.state).toBe(FIGURE_STATE.LOADING)
    expect(l.drawable).toBe(false)
  })

  it('a failed cost source → UNAVAILABLE naming it; no bar at all', () => {
    const l = performanceLayout({ costComposition: { state: FIGURE_STATE.UNAVAILABLE, failedSources: ['supplierInvoices'] }, currentContractSum: ready(1) })
    expect(l.state).toBe(FIGURE_STATE.UNAVAILABLE)
    expect(l.failedSources).toEqual(['supplierInvoices'])
    expect(l.drawable).toBe(false)
    expect(l.contract).toBeNull()
  })

  it('a failed CONTRACT source removes only the contract bar (and it leaves the scale)', () => {
    const l = performanceLayout({ costComposition: comp(), currentContractSum: { state: FIGURE_STATE.UNAVAILABLE, failedSources: ['baseline'], value: null } })
    expect(l.state).toBe(FIGURE_STATE.READY)
    expect(l.contractRow.state).toBe(CONTRACT_ROW_STATE.UNAVAILABLE)
    expect(l.contractRow.failedSources).toEqual(['baseline'])
    expect(l.contract).toBeNull()
    expect(l.scale).toBe(1000)
    expect(l.drawable).toBe(true)
  })

  it('contract not set → its row says so; cost bars still drawn', () => {
    const l = performanceLayout({ costComposition: comp(), currentContractSum: { state: MARGIN_NOT_ESTABLISHED, failedSources: [], value: null } })
    expect(l.contractRow.state).toBe(CONTRACT_ROW_STATE.NOT_ESTABLISHED)
    expect(l.contract).toBeNull()
    expect(l.drawable).toBe(true)
  })

  it('a zero or negative contract sum is never drawn', () => {
    for (const v of [0, -500]) {
      const l = performanceLayout({ costComposition: comp(), currentContractSum: ready(v) })
      expect(l.contractRow.state).toBe(CONTRACT_ROW_STATE.NOT_DRAWABLE)
      expect(l.contractRow.value).toBe(v)
      expect(l.contract).toBeNull()
      expect(l.scale).toBe(1000)
    }
  })

  it('a negative cost component is never drawn to scale', () => {
    const l = performanceLayout({ costComposition: comp({ actual: -50 }), currentContractSum: ready(2000) })
    expect(l.state).toBe(FIGURE_STATE.READY)
    expect(l.drawable).toBe(false)
    expect(l.reason).toBe('negative')
    expect(l.segments).toEqual([])
  })

  it('a settled empty project → not drawable (no fake bar, no NaN)', () => {
    const l = performanceLayout({
      costComposition: comp({ actual: 0, remainingCommitted: 0, uncommittedCostToComplete: 0, forecastFinalCost: 0, approvedBudget: 0 }),
      currentContractSum: { state: MARGIN_NOT_ESTABLISHED, failedSources: [], value: null },
    })
    expect(l.drawable).toBe(false)
    expect(l.reason).toBe('no_values')
  })

  it('zero approved budget: no budget bar and no marker', () => {
    const l = performanceLayout({ costComposition: comp({ approvedBudget: 0 }), currentContractSum: ready(2000) })
    expect(l.budget).toBeNull()
    expect(l.budgetMarkerPct).toBeNull()
    expect(l.drawable).toBe(true)
  })

  it('a missing input is treated as unavailable, never drawn', () => {
    expect(performanceLayout().state).toBe(FIGURE_STATE.UNAVAILABLE)
  })
})

// ── 3. Programme ─────────────────────────────────────────────────────────────

const NOW = new Date(2026, 9, 16) // 16 Oct 2026, local time
const ACTIVITIES = [
  { id: 'a1', status: 'completed',   plannedStart: '2026-09-01', plannedFinish: '2026-09-10' },
  { id: 'a2', status: 'in_progress', plannedStart: '2026-09-15', plannedFinish: '2026-10-01' }, // overdue
  { id: 'a3', status: 'not_started', plannedStart: '2026-10-20', plannedFinish: '2026-10-25' }, // due soon
  { id: 'a4', status: 'not_started', isMilestone: true, plannedStart: '2026-12-01', plannedFinish: '2026-12-01' },
  { id: 'a5', status: 'on_hold',     plannedStart: '2026-10-01', plannedFinish: '2026-11-30' },
  { id: 'a6', status: 'cancelled',   plannedStart: '2026-08-01', plannedFinish: '2026-08-02' },
  { id: 'a7', status: 'legacy-value', plannedStart: '2026-08-01', plannedFinish: '2026-08-02' },
]

describe('programme figures ARE timelineSummary', () => {
  const o = programmeOverview(ACTIVITIES, NOW)

  it('the summary is timelineSummary unchanged', () => {
    expect(o.summary).toEqual(timelineSummary(ACTIVITIES, NOW))
  })

  it('the fixtures exercise every panel figure', () => {
    expect(o.summary.completed).toBe(1)
    expect(o.summary.overdue).toBeGreaterThan(0)
    expect(o.summary.dueSoon).toBeGreaterThan(0)
    expect(o.summary.milestonesRemaining).toBe(1)
  })

  it('the status tally always sums to the activity total (unknown status → other)', () => {
    const sum = o.byStatus.reduce((n, s) => n + s.count, 0) + o.other
    expect(sum).toBe(o.summary.total)
    expect(o.other).toBe(1)
  })

  it('the tally agrees with timelineSummary where both report a figure', () => {
    const by = Object.fromEntries(o.byStatus.map(s => [s.status, s.count]))
    expect(by.completed).toBe(o.summary.completed)
    expect(by.in_progress).toBe(o.summary.inProgress)
    expect(by.not_started + by.in_progress + by.on_hold).toBe(o.summary.open)
  })

  it('an empty programme is a genuine zero', () => {
    const e = programmeOverview([], NOW)
    expect(e.summary.total).toBe(0)
    expect(donutSegments(e.byStatus, e.other)).toEqual({ total: 0, segments: [] })
  })

  it('activityStatusCounts tolerates a missing list', () => {
    expect(activityStatusCounts(undefined).other).toBe(0)
  })
})

describe('donut geometry: counts, never a completion percentage', () => {
  const o = programmeOverview(ACTIVITIES, NOW)
  const d = donutSegments(o.byStatus, o.other)

  it('segments cover exactly the ring and omit zero counts', () => {
    const covered = d.segments.reduce((n, s) => n + s.lengthPct, 0)
    expect(covered).toBeCloseTo(100, 9)
    expect(d.segments.every(s => s.count > 0)).toBe(true)
    expect(d.total).toBe(o.summary.total)
  })

  it('offsets are contiguous and dash values match', () => {
    let offset = 0
    for (const s of d.segments) {
      expect(s.offsetPct).toBeCloseTo(offset, 9)
      expect(s.dashOffset).toBeCloseTo(-offset, 9)
      expect(s.dashArray).toBe(`${s.lengthPct} ${100 - s.lengthPct}`)
      offset += s.lengthPct
    }
  })

  it('the programme module and panel compute no completion percentage', () => {
    const lib = stripComments(read('lib/dashboardProgramme.js'))
    const panel = stripComments(read('pages/dashboard/ProgrammePanel.jsx'))
    for (const code of [lib, panel]) {
      expect(code).not.toMatch(/completed\s*\/\s*\w*total/i)
      expect(code).not.toContain('percent(')
      expect(code).not.toContain('72%')
    }
    expect(panel).toContain('{`${s.completed} of ${s.total}`}')
  })
})

// ── 4. Portfolio counts ──────────────────────────────────────────────────────

const PROJECTS = [
  { id: 'p1', status: 'In Progress' }, { id: 'p2', status: 'In Progress' },
  { id: 'p3', status: 'Planning' }, { id: 'p4', status: 'Legacy' },
]

describe('portfolio counts are never a false zero', () => {
  it('loading → null counts (rendered "—"), not 0', () => {
    const p = portfolioSummary({ projects: [], loading: true, error: false })
    expect(p.listState).toBe(PROJECTS_LIST_STATE.LOADING)
    expect(p.active).toBeNull()
    expect(p.total).toBeNull()
    expect(p.statusCounts).toBeNull()
  })

  it('failed read → null counts and UNAVAILABLE, not 0', () => {
    const p = portfolioSummary({ projects: [], loading: false, error: true })
    expect(p.listState).toBe(PROJECTS_LIST_STATE.UNAVAILABLE)
    expect(p.active).toBeNull()
    expect(p.total).toBeNull()
  })

  it('a settled empty company → genuine zeros', () => {
    const p = portfolioSummary({ projects: [], loading: false, error: false })
    expect(p.listState).toBe(PROJECTS_LIST_STATE.EMPTY)
    expect(p.active).toBe(0)
    expect(p.total).toBe(0)
  })

  it('settled → real counts from the list', () => {
    const p = portfolioSummary({ projects: PROJECTS, loading: false, error: false })
    expect(p.active).toBe(2)
    expect(p.total).toBe(4)
    expect(p.statusCounts.other).toBe(1)
  })

  it('the status bar covers 100% and omits zero-count statuses', () => {
    const segs = statusBarSegments(portfolioSummary({ projects: PROJECTS, loading: false, error: false }).statusCounts)
    expect(segs.map(s => s.status)).toEqual(['Planning', 'In Progress', 'Other'])
    expect(segs.reduce((n, s) => n + s.widthPct, 0)).toBeCloseTo(100, 9)
    expect(statusBarSegments(null)).toEqual([])
  })

  it('the portfolio component renders "—" / Unavailable, never a coerced 0', () => {
    const code = stripComments(read('pages/dashboard/PortfolioSummary.jsx'))
    expect(code).toContain("{unavailable ? 'Unavailable' : value === null ? '—' : value}")
    expect(code).not.toMatch(/\?\?\s*0/)
    expect(code).not.toContain('formatCurrency')
  })
})

// ── 5. Structure ─────────────────────────────────────────────────────────────

describe('roles: each child mounts only behind its own gate', () => {
  const dashboard = stripComments(read('pages/Dashboard.jsx'))
  const panel = stripComments(read('pages/dashboard/ProgrammePanel.jsx'))

  it('programme readers and financial roles exclude subcontractor and client', () => {
    for (const role of ['subcontractor', 'client', undefined, null, '']) {
      expect(canReadProgramme(role)).toBe(false)
      expect(isFinancialRole(role)).toBe(false)
    }
    for (const role of ['company_admin', 'project_manager', 'qs']) {
      expect(canReadProgramme(role)).toBe(true)
    }
  })

  it('the Dashboard mounts no activities subscription itself', () => {
    expect(dashboard).not.toContain('useProjectActivities')
  })

  it('the panel opens exactly one subscription, for the project it is given', () => {
    // useLocalToday is a midnight timer, not a subscription — pinned below.
    expect(panel.match(/use[A-Z]\w+\(/g).filter(h => h !== 'useMemo(' && h !== 'useLocalToday(')).toEqual(['useProjectActivities('])
    expect(panel).toContain('useProjectActivities(projectId)')
  })

  it('useLocalToday (the panel clock) opens no Firestore listener and reads nothing', () => {
    const clock = stripComments(read('hooks/useLocalToday.jsx'))
    expect(clock).not.toContain('onSnapshot')
    expect(clock).not.toContain('firebase')
    expect(clock).not.toMatch(/\bgetDocs?\(/)
    expect(panel).toContain('const now = useLocalToday()')
    expect(panel).toContain('programmeOverview(activities, now)')
  })

  it('the panel is rendered only behind canReadProgramme, keyed by the selected project', () => {
    expect(dashboard).toContain('const canViewProgramme = canReadProgramme(profile?.role)')
    expect(dashboard).toContain('aside={canViewProgramme ? <ProgrammePanel key={selectedProject.id} projectId={selectedProject.id} /> : null}')
    expect(dashboard.match(/<ProgrammePanel\b/g)).toHaveLength(1)
    // …and only inside the financial-role-gated snapshot section.
    const gate = dashboard.indexOf('{canViewSnapshot && selectedProject && (')
    expect(dashboard.indexOf('<ProgrammePanel')).toBeGreaterThan(gate)
  })

  it('the panel consumes no write callback', () => {
    expect(panel).not.toMatch(/\b(createActivity|updateActivity|cancelActivity)\b/)
  })

  it('the Dashboard adds exactly one subscription to ADR-42: no other hook is mounted', () => {
    const hooks = new Set()
    for (const f of DASHBOARD_FILES) {
      for (const m of stripComments(read(f)).matchAll(/\b(use[A-Z]\w+)\(/g)) hooks.add(m[1])
    }
    expect([...hooks].sort()).toEqual([
      'useAuth', 'useBudgetLines', 'useCompany', 'useForecastLines', 'useLocalToday', 'useMemo', 'useNavigate',
      'useProfile', 'useProgressClaims', 'useProjectActivities', 'useProjectCommercial', 'useProjects',
      'usePurchaseOrders', 'useRef', 'useRetentionReleases', 'useSearchParams', 'useSupplierCreditNotes',
      'useSupplierInvoices', 'useSupplierPayments', 'useVariations',
    ])
  })
})

describe('selection, isolation and currency', () => {
  const dashboard = stripComments(read('pages/Dashboard.jsx'))

  it('selection still comes from ?project= and is written with replace', () => {
    expect(dashboard).toContain("selectSnapshotProjectId(projects, searchParams.get('project'))")
    expect(dashboard).toContain("next.set('project', projectId)")
    expect(dashboard).toContain('{ replace: true }')
  })

  it('the snapshot is keyed by project and given that project\'s resolved currency', () => {
    expect(dashboard).toContain('key={selectedProject.id}')
    expect(dashboard).toContain('currencyCode={resolveProjectCurrency(selectedProject, company)}')
  })

  it('the snapshot carries the selected project\'s currency into every figure', () => {
    expect(snap(SOURCES, settled(), 'NZD').currencyCode).toBe('NZD')
    const s = stripComments(read('pages/dashboard/ProjectSnapshot.jsx'))
    expect(s).toContain('const money = (n) => formatCurrency(n, snapshot.currencyCode)')
  })

  it('no dashboard file hard-codes a currency or sums money across projects', () => {
    for (const f of DASHBOARD_FILES) {
      const code = stripComments(read(f))
      expect(code, f).not.toMatch(/'(AUD|NZD|USD|GBP|EUR|ZAR)'/)
      expect(code, f).not.toMatch(/\.reduce\(/)
      expect(code, f).not.toContain('roundMoney')
    }
  })

  it('the chart and cards import no financial selector — geometry and figures come from lib/projectSnapshot', () => {
    for (const f of DASHBOARD_FILES) {
      const code = stripComments(read(f))
      for (const lib of ['lib/forecast', 'lib/purchaseOrders', 'lib/progressClaims', 'lib/supplierInvoices',
        'lib/supplierCreditNotes', 'lib/supplierPayments', 'lib/variations', 'lib/retention', 'lib/cashFlow']) {
        expect(code, `${f} imports ${lib}`).not.toContain(lib)
      }
    }
  })
})

describe('design system and responsive structure', () => {
  it('no chart library, no Firebase, no inline style object, no hard-coded hex', () => {
    for (const f of DASHBOARD_FILES) {
      const code = stripComments(read(f))
      expect(code, f).not.toContain('recharts')
      expect(code, f).not.toContain('firebase/')
      expect(code, f).not.toContain('style={{')
      expect(code, f).not.toMatch(/#[0-9A-Fa-f]{3,8}\b/)
    }
  })

  it('KPI cards reflow 1 → 2 → 4 columns; chart sits beside the programme panel from lg', () => {
    const s = read('pages/dashboard/ProjectSnapshot.jsx')
    expect(s).toContain('grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4')
    expect(s).toContain('grid grid-cols-1 gap-3.5 lg:grid-cols-3')
    expect(s).toContain("aside ? 'lg:col-span-2' : 'lg:col-span-3'")
  })

  it('the register is a table from lg and stacked cards below it', () => {
    const r = read('pages/dashboard/ProjectRegister.jsx')
    expect(r).toContain('hidden lg:block overflow-x-auto')
    expect(r).toContain('lg:hidden')
    expect(r).not.toContain('hidden md:table')
  })

  it('interactive controls keep 44px touch targets', () => {
    const dashboard = read('pages/Dashboard.jsx')
    expect(dashboard).toMatch(/id="snapshot-project"[\s\S]*?min-h-\[44px\]/)
    for (const f of ['pages/dashboard/ProjectSnapshot.jsx', 'pages/dashboard/ProgrammePanel.jsx', 'pages/dashboard/CostPerformanceChart.jsx']) {
      const code = read(f)
      const links = code.match(/<Link\b[\s\S]*?>/g) ?? []
      expect(links.length, f).toBeGreaterThan(0)
      for (const l of links) expect(l, f).toContain('min-h-[44px]')
    }
  })

  it('no Coming Soon or intelligence placeholder on the Dashboard', () => {
    for (const f of DASHBOARD_FILES) {
      const code = stripComments(read(f))
      for (const s of ['Coming Soon', 'PULSE', 'SHIELD', 'IQ™', 'Quant™', 'health score']) {
        expect(code, f).not.toContain(s)
      }
    }
  })
})

describe('figureState is reused for the programme read (one vocabulary)', () => {
  it('activities loading / failed / settled map to the shared states', () => {
    expect(figureState(['activities'], { activities: { loading: true, error: false } }).state).toBe(FIGURE_STATE.LOADING)
    expect(figureState(['activities'], { activities: { loading: false, error: true } }).state).toBe(FIGURE_STATE.UNAVAILABLE)
    expect(figureState(['activities'], { activities: { loading: false, error: false } }).state).toBe(FIGURE_STATE.READY)
  })

  it('the panel derives its state through figureState, never from the array alone', () => {
    const panel = stripComments(read('pages/dashboard/ProgrammePanel.jsx'))
    expect(panel).toContain("figureState(['activities'], {")
    expect(panel).toContain('activities: { loading: activitiesLoading, error: activitiesError }')
  })
})
