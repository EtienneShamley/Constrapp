import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  buildPortfolioReport, portfolioRow, portfolioScope, portfolioSourceStates, loadingSourceStates,
  subtotalFor, marginSubtotal, isValidFigure, isPortfolioExportable, portfolioScopeText,
  portfolioFigureText, portfolioSubtotalText, portfolioSubtotalNote, riskSummaryText, riskOf, isOpenProject,
  PORTFOLIO_FIGURES, PORTFOLIO_FIGURE_KEYS, PORTFOLIO_FIGURE_STATE, PORTFOLIO_INDICATORS,
  SUBTOTAL_STATE, COMPLETENESS, RISK,
} from '../../src/lib/portfolioReport'
import {
  portfolioReportCsv, portfolioReportFilename, portfolioFigureCsvValue, portfolioSubtotalCsvValue,
  PORTFOLIO_CSV_MARKER,
} from '../../src/lib/portfolioReportCsv'
import { buildCommercialReport, REPORT_SOURCES, FIGURE_KIND } from '../../src/lib/commercialReport'
import { FIGURE_STATE } from '../../src/lib/projectSnapshot'
import { marginPercent } from '../../src/lib/margin'
import { INDICATOR, PULSE_STATE } from '../../src/lib/pulse'
import { loadProjectSources } from '../../src/lib/portfolioSources'
import { readyProject, sourcesOf, EXPECTED_FIGURES } from '../fixtures/finalAccountProject'
import { fakeReader, projectStore } from '../fixtures/portfolioReader'

// ── L2-C Portfolio Report — the model and its export (ADR-78) ────────────────
//
// The portfolio must be a COMPOSITION: a project row is that project's L2-A
// Commercial Report, and the only things added are currency grouping,
// all-or-nothing subtotals in integer cents, and the aggregate margin. These
// tests pin exactly that — and the things the page must never do: add two
// currencies, total an incomplete group, read a working budget as approved,
// or present an unevaluated indicator as clear.

const read = (rel) => readFileSync(fileURLToPath(new URL(`../../src/${rel}`, import.meta.url)), 'utf8')
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

const NOW = new Date(2026, 10, 20, 9, 0, 0)
const COMPANY = { id: 'coA', name: 'Acme Builders', baseCurrency: 'AUD' }
const LOADED_AT = new Date(2026, 10, 20, 9, 0, 5)

// A settled one-shot result for a readyProject()-shaped document set — through
// the REAL loader and a fake reader, so the path under test is the page's own.
async function resultOf(p, readerOptions) {
  const loaded = await loadProjectSources(fakeReader({ x: projectStore(p) }, readerOptions), { companyId: 'coA', projectId: 'x' })
  return { ...loaded, loadedAt: LOADED_AT }
}
const proj = (id, over = {}) => ({ id, name: `Project ${id}`, status: 'In Progress', currency: 'AUD', ...over })

// The shared fixture: contract 12,000 · approved budget 7,000 · actual 6,000 ·
// FFC 6,000 · variance 1,000 · profit 6,000 (50%) · payable 1,490 · receivable 2,200.
const READY = {
  currentContractSum: 12000, approvedBudget: 7000, actual: 6000, remainingCommitted: 0, forecastFinalCost: 6000,
  varianceToBudget: 1000, forecastGrossProfit: 6000, forecastMarginPct: 50,
  remainingPayable: 1490, receivablesOutstanding: 2200, pendingClientVariations: 0,
}

// A second project with different, non-round figures: every amount ×1.1 + cents.
const scaled = () => {
  const p = readyProject()
  p.baseline = { originalContractValue: 4100.1, originalApprovedBudget: null }
  p.variations = [
    { id: 'v2', variationNumber: 'CV-0002', variationType: 'client', status: 'submitted', submittedSubtotal: 333.33, lineItems: [] },
  ]
  return p
}
// contract 4,100.10 · FFC 6,000 → profit −1,899.90 · pending client variation 333.33

const working = () => {
  const p = readyProject()
  p.pointer = null
  p.budgetApprovals = []
  p.budgetApprovalSnapshots = []
  return p
}

const build = (projects, results, over = {}) =>
  buildPortfolioReport({ projects, company: COMPANY, results, now: NOW, ...over })
const group = (portfolio, ccy) => portfolio.groups.find(g => g.currencyCode === ccy)
const valuesOf = (row) => Object.fromEntries(PORTFOLIO_FIGURE_KEYS.map(k => [k, row.figures[k].value]))

// ── 1. Selector parity with the L2-A Commercial Report ───────────────────────

describe('a portfolio row IS the project\'s Commercial Report', () => {
  it('every figure equals the L2-A report figure for the same records', async () => {
    const p = readyProject()
    const result = await resultOf(p)
    const row = portfolioRow({ project: proj('p1'), company: COMPANY, result, now: NOW })

    const sources = { ...sourcesOf(p), approvedBudget: result.sources.approvedBudget }
    const report = buildCommercialReport({
      project: proj('p1'), currencyCode: 'AUD', sources,
      sourceStates: Object.fromEntries(REPORT_SOURCES.map(s => [s, { loading: false, error: false }])),
    })
    for (const spec of PORTFOLIO_FIGURES) {
      const f = report[spec.from].find(i => i.key === spec.reportKey).figure
      expect(row.figures[spec.key]).toEqual({ state: f.state, failedSources: f.failedSources, value: f.value })
      expect(f.state).toBe(FIGURE_STATE.READY)
    }
    expect(row.budget.caption).toBe(report.budgetSourceCaption)
  })

  it('and equals the independently stated expected figures (none of them zero by accident)', async () => {
    const row = portfolioRow({ project: proj('p1'), company: COMPANY, result: await resultOf(readyProject()), now: NOW })
    expect(valuesOf(row)).toEqual(READY)
    expect(READY.currentContractSum).toBe(EXPECTED_FIGURES.finalContractSum)
    expect(READY.approvedBudget).toBe(EXPECTED_FIGURES.approvedBudget)
    expect(READY.actual).toBe(EXPECTED_FIGURES.actualCost)
    expect(READY.varianceToBudget).toBe(EXPECTED_FIGURES.varianceToBudget)
    expect(READY.remainingPayable).toBe(EXPECTED_FIGURES.payablesOutstanding)
    expect(READY.receivablesOutstanding).toBe(EXPECTED_FIGURES.receivablesOutstanding)
    expect(row.budget).toMatchObject({ approved: true, working: false, caption: 'Approved version 1' })
    expect(row.completeness).toBe(COMPLETENESS.COMPLETE)
    expect(row.loadedAt).toBe(LOADED_AT)
  })

  it('every column is read out of the report by key — the model computes no project figure', () => {
    const code = stripComments(read('lib/portfolioReport.js'))
    expect(code).toContain('buildCommercialReport({ project, currencyCode, sources, sourceStates })')
    expect(code).toContain('evaluatePulse({ sources, sourceStates, now, currencyCode })')
    // The one formula it calls is the app's own margin function.
    expect(code).toContain(`import { marginPercent } from './margin'`)
    for (const selector of ['projectForecastTotals', 'computeMargin', 'payablesSummary', 'receivablesSummary', 'forecastRollups', 'roundMoney']) {
      expect(code).not.toContain(selector)
    }
    expect(code).not.toMatch(/from 'firebase/)
  })

  it('the source states are derived exactly as the Reports tab derives them', async () => {
    const result = await resultOf(readyProject())
    const states = portfolioSourceStates({ sources: result.sources, readStates: result.readStates, currencyCode: 'AUD' })
    expect(Object.keys(states).sort()).toEqual([...REPORT_SOURCES].sort())
    for (const s of REPORT_SOURCES) expect(states[s]).toEqual({ loading: false, error: false })
    // Missing read-state information is a failure, never success.
    const missing = portfolioSourceStates({ sources: result.sources, readStates: {}, currencyCode: 'AUD' })
    expect(missing.purchaseOrders).toEqual({ loading: false, error: true })
    // A currency that disagrees with the approved snapshot fails the budget closed.
    const wrong = portfolioSourceStates({ sources: result.sources, readStates: result.readStates, currencyCode: 'NZD' })
    expect(wrong.approvedBudget).toEqual({ loading: false, error: true })
  })
})

// ── 2. Scope ─────────────────────────────────────────────────────────────────

describe('scope: open projects by default', () => {
  const projects = [
    proj('a'), proj('b', { status: 'Completed' }), proj('c', { status: 'Planning' }),
    proj('d', { status: 'Legacy value' }), proj('e', { status: 'On Hold' }),
  ]

  it('completed projects are excluded by default and counted as excluded', () => {
    const s = portfolioScope(projects)
    expect(s.inScope.map(p => p.id)).toEqual(['a', 'c', 'd', 'e'])
    expect(s).toMatchObject({ totalCount: 5, completedCount: 1, excludedCount: 1, includeCompleted: false })
  })

  it('include-completed brings every project in, in the existing order', () => {
    const s = portfolioScope(projects, { includeCompleted: true })
    expect(s.inScope.map(p => p.id)).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(s.excludedCount).toBe(0)
  })

  it('a project with an out-of-vocabulary status is open — it never drops out silently', () => {
    expect(isOpenProject({ status: 'Legacy value' })).toBe(true)
    expect(isOpenProject({ status: 'Completed' })).toBe(false)
  })

  it('the scope is stated in words', () => {
    expect(portfolioScopeText(build(projects, {}).scope)).toBe('Open projects (4 projects); 1 completed not included')
    expect(portfolioScopeText(build(projects, {}, { includeCompleted: true }).scope)).toBe('All projects, including completed (5 projects)')
    expect(portfolioScopeText(build([proj('a')], {}).scope)).toBe('Open projects (1 project)')
  })

  it('a completed project is not a row — so it is never loaded', () => {
    const portfolio = build(projects, {})
    expect(portfolio.rows.map(r => r.projectId)).toEqual(['a', 'c', 'd', 'e'])
  })
})

// ── 3. Empty, single, loading ────────────────────────────────────────────────

describe('empty, single-project and loading portfolios', () => {
  it('an empty portfolio has no groups, no totals and cannot be exported', () => {
    const portfolio = build([], {})
    expect(portfolio.groups).toEqual([])
    expect(portfolio.counts).toMatchObject({ projects: 0, currencies: 0 })
    expect(portfolio.coverage).toBe(COMPLETENESS.COMPLETE)
    expect(isPortfolioExportable(portfolio)).toBe(false)
  })

  it('a portfolio of only completed projects is empty by default', () => {
    const portfolio = build([proj('a', { status: 'Completed' })], {})
    expect(portfolio.rows).toEqual([])
    expect(portfolio.scope.excludedCount).toBe(1)
  })

  it('one project: the subtotal is that project\'s figure, to the cent', async () => {
    const portfolio = build([proj('a')], { a: await resultOf(readyProject()) })
    const g = group(portfolio, 'AUD')
    for (const spec of PORTFOLIO_FIGURES) {
      expect(g.subtotals[spec.key]).toMatchObject({ state: SUBTOTAL_STATE.COMPLETE, value: READY[spec.key], included: 1, total: 1, affected: 0 })
    }
    expect(isPortfolioExportable(portfolio)).toBe(true)
  })

  it('a project not read yet is LOADING in every figure — "—", never 0', () => {
    const portfolio = build([proj('a')], {})
    const row = portfolio.rows[0]
    for (const spec of PORTFOLIO_FIGURES) {
      expect(row.figures[spec.key]).toMatchObject({ state: FIGURE_STATE.LOADING, value: null })
      expect(portfolioFigureText(row.figures[spec.key], spec.kind, String, String)).toBe('—')
      expect(group(portfolio, 'AUD').subtotals[spec.key]).toMatchObject({ state: SUBTOTAL_STATE.LOADING, value: null })
    }
    expect(row.completeness).toBe(COMPLETENESS.LOADING)
    expect(row.indicators.counts[RISK.LOADING]).toBe(PORTFOLIO_INDICATORS.length)
    expect(portfolio.coverage).toBe(COMPLETENESS.LOADING)
    expect(portfolio.loading).toBe(true)
    expect(isPortfolioExportable(portfolio)).toBe(false)
    expect(Object.values(loadingSourceStates()).every(s => s.loading === true && s.error === false)).toBe(true)
  })

  it('while one project is still loading, its group has NO subtotal — the loaded project is not presented as the total', async () => {
    const portfolio = build([proj('a'), proj('b')], { a: await resultOf(readyProject()) })
    const s = group(portfolio, 'AUD').subtotals.actual
    expect(s).toMatchObject({ state: SUBTOTAL_STATE.LOADING, value: null, included: 1, total: 2, affected: 1 })
    expect(portfolioSubtotalText(s, FIGURE_KIND.MONEY, String, String)).toBe('—')
  })
})

// ── 4. Same-currency subtotals, integer cents ────────────────────────────────

describe('subtotals within ONE currency', () => {
  it('two AUD projects: each money subtotal is the exact sum of the two rows', async () => {
    const portfolio = build([proj('a'), proj('b')], { a: await resultOf(readyProject()), b: await resultOf(scaled()) })
    const g = group(portfolio, 'AUD')
    expect(g.projectCount).toBe(2)
    expect(g.subtotals.currentContractSum.value).toBe(16100.1)
    expect(g.subtotals.approvedBudget.value).toBe(14000)
    expect(g.subtotals.actual.value).toBe(12000)
    expect(g.subtotals.forecastFinalCost.value).toBe(12000)
    expect(g.subtotals.varianceToBudget.value).toBe(2000)
    expect(g.subtotals.forecastGrossProfit.value).toBe(4100.1)
    expect(g.subtotals.remainingPayable.value).toBe(2980)
    expect(g.subtotals.receivablesOutstanding.value).toBe(4400)
    expect(g.subtotals.pendingClientVariations.value).toBe(333.33)
    for (const spec of PORTFOLIO_FIGURES) expect(g.subtotals[spec.key].state).toBe(SUBTOTAL_STATE.COMPLETE)
  })

  it('sums in integer cents — 0.10 + 0.20 is 0.30, not 0.30000000000000004', () => {
    const rows = [0.1, 0.2].map(v => ({ figures: { actual: { state: FIGURE_STATE.READY, failedSources: [], value: v } } }))
    expect(0.1 + 0.2).not.toBe(0.3)
    expect(subtotalFor(rows, 'actual').value).toBe(0.3)
    const many = Array.from({ length: 1000 }, () => ({ figures: { actual: { state: FIGURE_STATE.READY, failedSources: [], value: 0.01 } } }))
    expect(subtotalFor(many, 'actual').value).toBe(10)
    const signed = [1000.05, -2000.1, 0].map(v => ({ figures: { actual: { state: FIGURE_STATE.READY, failedSources: [], value: v } } }))
    expect(subtotalFor(signed, 'actual').value).toBe(-1000.05)
  })

  it('a genuine zero is a valid figure and a zero subtotal is a real 0', () => {
    const rows = [0, 0].map(v => ({ figures: { actual: { state: FIGURE_STATE.READY, failedSources: [], value: v } } }))
    expect(subtotalFor(rows, 'actual')).toMatchObject({ state: SUBTOTAL_STATE.COMPLETE, value: 0 })
    expect(isValidFigure({ state: FIGURE_STATE.READY, value: 0 })).toBe(true)
    expect(isValidFigure({ state: FIGURE_STATE.READY, value: null })).toBe(false)
    expect(isValidFigure({ state: FIGURE_STATE.UNAVAILABLE, value: 5 })).toBe(false)
    expect(isValidFigure({ state: FIGURE_STATE.READY, value: NaN })).toBe(false)
  })
})

// ── 5. Margin: aggregate, never an average ───────────────────────────────────

describe('group margin = aggregate gross profit ÷ aggregate contract sum', () => {
  it('uses the app\'s margin formula over the two subtotals, not the mean of project percentages', async () => {
    const portfolio = build([proj('a'), proj('b')], { a: await resultOf(readyProject()), b: await resultOf(scaled()) })
    const g = group(portfolio, 'AUD')
    const [a, b] = g.rows
    expect(a.figures.forecastMarginPct.value).toBe(50)
    expect(b.figures.forecastGrossProfit.value).toBe(-1899.9)
    expect(b.figures.forecastMarginPct.value).toBeLessThan(0)

    const aggregate = marginPercent(4100.1, 16100.1)
    const average = (a.figures.forecastMarginPct.value + b.figures.forecastMarginPct.value) / 2
    expect(g.subtotals.forecastMarginPct).toMatchObject({ state: SUBTOTAL_STATE.COMPLETE, value: aggregate })
    expect(aggregate).toBe(25.47)
    expect(Math.abs(aggregate - average)).toBeGreaterThan(10)
  })

  it('is suppressed when either input is incomplete', async () => {
    const noContract = readyProject()
    noContract.baseline = null
    const portfolio = build([proj('a'), proj('b')], { a: await resultOf(readyProject()), b: await resultOf(noContract) })
    const g = group(portfolio, 'AUD')
    expect(g.rows[1].figures.currentContractSum.state).toBe(PORTFOLIO_FIGURE_STATE.NOT_SET)
    expect(g.rows[1].contractNotEstablished).toBe(true)
    expect(g.subtotals.currentContractSum).toMatchObject({ state: SUBTOTAL_STATE.INCOMPLETE, value: null, affected: 1 })
    expect(g.subtotals.forecastGrossProfit.state).toBe(SUBTOTAL_STATE.INCOMPLETE)
    expect(g.subtotals.forecastMarginPct).toMatchObject({ state: SUBTOTAL_STATE.INCOMPLETE, value: null, included: 1, total: 2, affected: 1 })
    // Cost figures do not need the contract and are still totalled.
    expect(g.subtotals.forecastFinalCost).toMatchObject({ state: SUBTOTAL_STATE.COMPLETE, value: 12000 })
    expect(portfolio.counts.contractNotSet).toBe(1)
  })

  it('is "not calculable" — not zero — when the aggregate contract sum is not positive', () => {
    const rows = [
      { figures: { forecastGrossProfit: { state: FIGURE_STATE.READY, value: -500 }, currentContractSum: { state: FIGURE_STATE.READY, value: 0 } } },
    ]
    const gp = subtotalFor(rows, 'forecastGrossProfit')
    const ccs = subtotalFor(rows, 'currentContractSum')
    const m = marginSubtotal(rows, gp, ccs)
    expect(m).toMatchObject({ state: SUBTOTAL_STATE.NOT_CALCULABLE, value: null })
    expect(portfolioSubtotalText(m, FIGURE_KIND.PERCENT, String, String)).toBe('Not calculable')
  })

  it('is loading, not incomplete, while its inputs are only loading', () => {
    const rows = [{ figures: { forecastGrossProfit: { state: FIGURE_STATE.LOADING, value: null }, currentContractSum: { state: FIGURE_STATE.LOADING, value: null } } }]
    const m = marginSubtotal(rows, subtotalFor(rows, 'forecastGrossProfit'), subtotalFor(rows, 'currentContractSum'))
    expect(m.state).toBe(SUBTOTAL_STATE.LOADING)
  })
})

// ── 6. Mixed currencies ──────────────────────────────────────────────────────

describe('currencies are never combined', () => {
  const projects = [
    proj('a', { currency: 'AUD' }), proj('n', { currency: 'NZD' }), proj('b', { currency: 'BSD' }), proj('a2', { currency: 'AUD' }),
  ]
  const nz = () => {
    const p = scaled()
    p.budgetApprovals[0].currency = 'NZD'
    p.budgetApprovalSnapshots[0].currency = 'NZD'
    return p
  }
  const bs = () => {
    const p = readyProject()
    p.budgetApprovals[0].currency = 'BSD'
    p.budgetApprovalSnapshots[0].currency = 'BSD'
    return p
  }
  const results = async () => ({
    a: await resultOf(readyProject()), n: await resultOf(nz()), b: await resultOf(bs()), a2: await resultOf(readyProject()),
  })

  it('one group per currency, each holding only its own projects', async () => {
    const portfolio = build(projects, await results())
    expect(portfolio.currencies).toEqual(['AUD', 'BSD', 'NZD'])
    expect(group(portfolio, 'AUD').rows.map(r => r.projectId)).toEqual(['a', 'a2'])
    expect(group(portfolio, 'NZD').rows.map(r => r.projectId)).toEqual(['n'])
    expect(group(portfolio, 'BSD').rows.map(r => r.projectId)).toEqual(['b'])
    for (const g of portfolio.groups) for (const r of g.rows) expect(r.currencyCode).toBe(g.currencyCode)
  })

  it('each subtotal is its own currency\'s sum; no figure anywhere is a cross-currency sum', async () => {
    const portfolio = build(projects, await results())
    expect(group(portfolio, 'AUD').subtotals.currentContractSum.value).toBe(24000)
    expect(group(portfolio, 'NZD').subtotals.currentContractSum.value).toBe(4100.1)
    expect(group(portfolio, 'BSD').subtotals.currentContractSum.value).toBe(12000)
    const crossSums = [24000 + 4100.1, 24000 + 12000, 4100.1 + 12000, 24000 + 4100.1 + 12000]
    const everyNumber = JSON.stringify(portfolio)
    for (const sum of crossSums) expect(everyNumber).not.toContain(String(sum))
  })

  it('the model exposes NO portfolio-wide money: only counts span currencies', async () => {
    const portfolio = build(projects, await results())
    expect(Object.keys(portfolio).sort()).toEqual(
      ['counts', 'coverage', 'currencies', 'groups', 'loadedFrom', 'loadedTo', 'loading', 'rows', 'scope'],
    )
    expect(portfolio.counts.projects).toBe(4)
    expect(portfolio.counts.currencies).toBe(3)
    const isCount = (v) => Number.isInteger(v)
    const walk = (v) => (typeof v === 'number' ? [v] : v && typeof v === 'object' ? Object.values(v).flatMap(walk) : [])
    expect(walk(portfolio.counts).every(isCount)).toBe(true)
  })

  it('the company base currency is never a reporting or conversion currency', async () => {
    const all = await results()
    const aud = build(projects, all, { company: { ...COMPANY, baseCurrency: 'AUD' } })
    const usd = build(projects, all, { company: { ...COMPANY, baseCurrency: 'USD' } })
    expect(usd.currencies).toEqual(aud.currencies)
    expect(usd.groups.map(g => g.subtotals)).toEqual(aud.groups.map(g => g.subtotals))
    const code = stripComments(read('lib/portfolioReport.js'))
    expect(code).not.toContain('baseCurrency')
    expect(code).not.toMatch(/exchange|convert|fxRate/i)
  })

  it('a legacy project with no stored currency inherits the company currency — and is MARKED', async () => {
    const legacy = { id: 'l', name: 'Legacy', status: 'In Progress' }
    const portfolio = build([legacy, proj('a')], { l: await resultOf(readyProject()), a: await resultOf(readyProject()) })
    const row = portfolio.rows.find(r => r.projectId === 'l')
    expect(row).toMatchObject({ currencyCode: 'AUD', currencyInherited: true })
    expect(portfolio.rows.find(r => r.projectId === 'a').currencyInherited).toBe(false)
    expect(group(portfolio, 'AUD').inheritedCount).toBe(1)
    expect(portfolio.counts.inheritedCurrency).toBe(1)
  })
})

// ── 7. Working versus approved budget ────────────────────────────────────────

describe('a working budget is never an Approved Budget', () => {
  it('the row shows NOT APPROVED; the working amount is carried apart, labelled', async () => {
    const row = portfolioRow({ project: proj('w'), company: COMPANY, result: await resultOf(working()), now: NOW })
    expect(row.budget).toMatchObject({ approved: false, working: true, caption: 'Working budget (not approved)' })
    expect(row.figures.approvedBudget).toEqual({ state: PORTFOLIO_FIGURE_STATE.NOT_APPROVED, failedSources: [], value: null, workingValue: 7000 })
    expect(row.figures.varianceToBudget).toEqual({ state: PORTFOLIO_FIGURE_STATE.NOT_APPROVED, failedSources: [], value: null, workingValue: 1000 })
    expect(portfolioFigureText(row.figures.approvedBudget, FIGURE_KIND.MONEY, String, String)).toBe('Not approved')
    // Everything that does not rest on the budget is unaffected.
    expect(row.figures.forecastFinalCost.value).toBe(6000)
    expect(row.figures.forecastGrossProfit.value).toBe(6000)
    expect(row.completeness).toBe(COMPLETENESS.COMPLETE)
  })

  it('budget and variance subtotals need an approved version for EVERY project', async () => {
    const portfolio = build([proj('a'), proj('w')], { a: await resultOf(readyProject()), w: await resultOf(working()) })
    const g = group(portfolio, 'AUD')
    for (const key of ['approvedBudget', 'varianceToBudget']) {
      expect(g.subtotals[key]).toMatchObject({
        state: SUBTOTAL_STATE.INCOMPLETE, value: null, included: 1, total: 2, affected: 1,
        reasons: { [PORTFOLIO_FIGURE_STATE.NOT_APPROVED]: 1 },
      })
    }
    expect(portfolioSubtotalNote(g.subtotals.approvedBudget)).toBe('Not totalled — 1 of 2 projects: 1 budget not approved')
    // The working 7,000 is in no subtotal — neither 14,000 nor 7,000 is shown.
    expect(portfolioSubtotalText(g.subtotals.approvedBudget, FIGURE_KIND.MONEY, String, String)).toBe('Incomplete')
    expect(g.subtotals.actual).toMatchObject({ state: SUBTOTAL_STATE.COMPLETE, value: 12000 })
    expect(g.workingBudgetCount).toBe(1)
    expect(portfolio.counts.workingBudget).toBe(1)
  })

  it('a project with no budget at all is still "not approved", never an approved 0', async () => {
    const p = working()
    p.budgetLines = []
    const row = portfolioRow({ project: proj('w'), company: COMPANY, result: await resultOf(p), now: NOW })
    expect(row.figures.approvedBudget).toMatchObject({ state: PORTFOLIO_FIGURE_STATE.NOT_APPROVED, value: null, workingValue: 0 })
  })

  it('an inconsistent approved record is Unavailable — it does not fall back to the working budget', async () => {
    const p = readyProject()
    p.budgetApprovalSnapshots[0].total = 6999
    const row = portfolioRow({ project: proj('x'), company: COMPANY, result: await resultOf(p), now: NOW })
    expect(row.budget).toMatchObject({ approved: false, working: false })
    expect(row.figures.approvedBudget).toMatchObject({ state: FIGURE_STATE.UNAVAILABLE, value: null })
    expect(row.figures.approvedBudget.failedSources).toContain('approvedBudget')
    expect(row.completeness).toBe(COMPLETENESS.INCOMPLETE)
  })
})

// ── 8. Failed sources and incomplete subtotals ───────────────────────────────

describe('a failed source is Unavailable and suppresses the subtotals that need it', () => {
  const failing = { fail: c => c.collection === 'supplierInvoices' }

  it('only the figures that read the failed source are Unavailable, naming it', async () => {
    const row = portfolioRow({ project: proj('f'), company: COMPANY, result: await resultOf(readyProject(), failing), now: NOW })
    for (const key of ['actual', 'remainingCommitted', 'forecastFinalCost', 'varianceToBudget', 'forecastGrossProfit', 'forecastMarginPct', 'remainingPayable']) {
      expect(row.figures[key]).toMatchObject({ state: FIGURE_STATE.UNAVAILABLE, value: null })
      expect(row.figures[key].failedSources).toContain('supplierInvoices')
      expect(portfolioFigureText(row.figures[key], FIGURE_KIND.MONEY, String, String)).toBe('Unavailable')
    }
    // Figures that do not read supplier invoices still render.
    expect(row.figures.currentContractSum.value).toBe(12000)
    expect(row.figures.approvedBudget.value).toBe(7000)
    expect(row.figures.receivablesOutstanding.value).toBe(2200)
    expect(row.completeness).toBe(COMPLETENESS.INCOMPLETE)
    expect(row.failedSources).toEqual(['supplierInvoices'])
  })

  it('the group does not total a figure with a failed project — and says how many are affected', async () => {
    const portfolio = build(
      [proj('a'), proj('f'), proj('c')],
      { a: await resultOf(readyProject()), f: await resultOf(readyProject(), failing), c: await resultOf(readyProject()) },
    )
    const g = group(portfolio, 'AUD')
    expect(g.subtotals.actual).toMatchObject({
      state: SUBTOTAL_STATE.INCOMPLETE, value: null, included: 2, total: 3, affected: 1,
      reasons: { [FIGURE_STATE.UNAVAILABLE]: 1 },
    })
    expect(portfolioSubtotalNote(g.subtotals.actual)).toBe('Not totalled — 1 of 3 projects: 1 unavailable')
    // The failed project is NOT silently dropped: 12,000 (the two good rows) appears nowhere.
    expect(JSON.stringify(g.subtotals.actual)).not.toContain('12000')
    expect(g.subtotals.currentContractSum).toMatchObject({ state: SUBTOTAL_STATE.COMPLETE, value: 36000 })
    expect(g.incompleteCount).toBe(1)
    expect(portfolio.coverage).toBe(COMPLETENESS.INCOMPLETE)
    expect(portfolio.counts).toMatchObject({ complete: 2, incomplete: 1, loading: 0 })
    // Settled, so it may be exported — with the incompleteness stated.
    expect(isPortfolioExportable(portfolio)).toBe(true)
  })

  it('a wholly failed project is Unavailable in every figure, not an empty zero-value project', async () => {
    const row = portfolioRow({ project: proj('f'), company: COMPANY, result: await resultOf(readyProject(), { fail: () => true }), now: NOW })
    for (const spec of PORTFOLIO_FIGURES) {
      expect(row.figures[spec.key]).toMatchObject({ state: FIGURE_STATE.UNAVAILABLE, value: null })
    }
    expect(row.completeness).toBe(COMPLETENESS.INCOMPLETE)
    expect(row.indicators.counts[RISK.NOT_EVALUATED]).toBe(PORTFOLIO_INDICATORS.length)
    expect(row.indicators.counts[RISK.CLEAR]).toBe(0)
  })
})

// ── 9. Negative margins and overruns ─────────────────────────────────────────

describe('adverse figures are carried signed', () => {
  const overrun = () => {
    const p = readyProject()
    // Budget 7,000, but a further 2,500 forecast to complete → FFC 8,500.
    p.forecastLines = [{ id: 'cc1', costCodeId: 'cc1', uncommittedCostToComplete: 2500 }, { id: 'cc2', costCodeId: 'cc2', uncommittedCostToComplete: 0 }]
    p.baseline = { originalContractValue: 6000, originalApprovedBudget: null }
    return p
  }

  it('a budget overrun is a negative variance and a negative margin is a negative margin', async () => {
    const row = portfolioRow({ project: proj('o'), company: COMPANY, result: await resultOf(overrun()), now: NOW })
    expect(row.figures.forecastFinalCost.value).toBe(8500)
    expect(row.figures.varianceToBudget.value).toBe(-1500)
    expect(row.figures.currentContractSum.value).toBe(8000)
    expect(row.figures.forecastGrossProfit.value).toBe(-500)
    expect(row.figures.forecastMarginPct.value).toBe(-6.25)
  })

  it('and the matching PULSE findings are confirmed findings', async () => {
    const row = portfolioRow({ project: proj('o'), company: COMPANY, result: await resultOf(overrun()), now: NOW })
    const risk = (id) => row.indicators.items.find(i => i.id === id).risk
    expect(risk(INDICATOR.FORECAST_OVER_BUDGET)).toBe(RISK.FINDING)
    expect(risk(INDICATOR.NEGATIVE_GROSS_PROFIT)).toBe(RISK.FINDING)
    expect(row.indicators.counts[RISK.FINDING]).toBeGreaterThanOrEqual(2)
  })

  it('negative subtotals stay negative', async () => {
    const portfolio = build([proj('o'), proj('o2')], { o: await resultOf(overrun()), o2: await resultOf(overrun()) })
    const g = group(portfolio, 'AUD')
    expect(g.subtotals.varianceToBudget.value).toBe(-3000)
    expect(g.subtotals.forecastGrossProfit.value).toBe(-1000)
    expect(g.subtotals.forecastMarginPct.value).toBe(-6.25)
    expect(portfolio.counts.withFindings).toBe(2)
  })
})

// ── 10. Financial PULSE indicators ───────────────────────────────────────────

describe('risk: the five financial PULSE indicators only', () => {
  it('exactly five, none of them a programme indicator', () => {
    expect(PORTFOLIO_INDICATORS).toEqual([
      INDICATOR.FORECAST_OVER_BUDGET, INDICATOR.FORECAST_INCOMPLETE, INDICATOR.NEGATIVE_GROSS_PROFIT,
      INDICATOR.PAST_DUE_SUPPLIER_INVOICES, INDICATOR.PENDING_VARIATION_EXPOSURE,
    ])
    for (const schedule of [INDICATOR.OVERDUE_ACTIVITIES, INDICATOR.BLOCKED_ACTIVITIES, INDICATOR.DEPENDENCY_REVIEW, INDICATOR.BASELINE_SLIPPAGE]) {
      expect(PORTFOLIO_INDICATORS).not.toContain(schedule)
    }
  })

  it('a row carries those five and nothing else', async () => {
    const row = portfolioRow({ project: proj('a'), company: COMPANY, result: await resultOf(readyProject()), now: NOW })
    expect(row.indicators.items.map(i => i.id)).toEqual(PORTFOLIO_INDICATORS)
    const total = Object.values(row.indicators.counts).reduce((s, n) => s + n, 0)
    expect(total).toBe(5)
    for (const i of row.indicators.items) expect(i.title).toBeTruthy()
  })

  it('a finding, no finding and not-evaluated are three different outcomes', () => {
    expect(riskOf(PULSE_STATE.FINDING)).toBe(RISK.FINDING)
    expect(riskOf(PULSE_STATE.NO_ISSUE)).toBe(RISK.CLEAR)
    expect(riskOf(PULSE_STATE.NEEDS_DATA)).toBe(RISK.NOT_EVALUATED)
    expect(riskOf(PULSE_STATE.UNAVAILABLE)).toBe(RISK.NOT_EVALUATED)
    expect(riskOf(PULSE_STATE.LOADING)).toBe(RISK.LOADING)
    // Anything unrecognised is NOT a clear result.
    expect(riskOf(undefined)).toBe(RISK.NOT_EVALUATED)
    expect(riskOf('healthy')).toBe(RISK.NOT_EVALUATED)
  })

  it('a past-due supplier invoice is a finding (evaluated against today)', async () => {
    // The fixture invoice was due 30 Sep 2026 with 1,490 still payable.
    const row = portfolioRow({ project: proj('a'), company: COMPANY, result: await resultOf(readyProject()), now: NOW })
    expect(row.indicators.items.find(i => i.id === INDICATOR.PAST_DUE_SUPPLIER_INVOICES).risk).toBe(RISK.FINDING)
    const before = portfolioRow({ project: proj('a'), company: COMPANY, result: await resultOf(readyProject()), now: new Date(2026, 8, 1) })
    expect(before.indicators.items.find(i => i.id === INDICATOR.PAST_DUE_SUPPLIER_INVOICES).risk).not.toBe(RISK.FINDING)
  })

  it('an indicator whose source failed is NOT EVALUATED and names the source — never clear', async () => {
    const result = await resultOf(readyProject(), { fail: c => c.collection === 'variations' })
    const row = portfolioRow({ project: proj('a'), company: COMPANY, result, now: NOW })
    const pending = row.indicators.items.find(i => i.id === INDICATOR.PENDING_VARIATION_EXPOSURE)
    expect(pending.risk).toBe(RISK.NOT_EVALUATED)
    expect(pending.failedSources).toContain('variations')
  })

  it('pending client variations are exposure, and are in no contract or profit figure', async () => {
    const row = portfolioRow({ project: proj('b'), company: COMPANY, result: await resultOf(scaled()), now: NOW })
    expect(row.figures.pendingClientVariations.value).toBe(333.33)
    expect(row.figures.currentContractSum.value).toBe(4100.1)
    expect(row.indicators.items.find(i => i.id === INDICATOR.PENDING_VARIATION_EXPOSURE).risk).toBe(RISK.FINDING)
    expect(PORTFOLIO_FIGURES.find(f => f.key === 'pendingClientVariations').pending).toBe(true)
  })

  it('portfolio indicator counts are counts of projects — no score, no rank', async () => {
    const portfolio = build([proj('a'), proj('b')], { a: await resultOf(readyProject()), b: await resultOf(scaled()) })
    for (const ind of portfolio.counts.indicators) {
      expect(ind.finding + ind.clear + ind.notEvaluated + ind.loading).toBe(2)
    }
    expect(JSON.stringify(portfolio)).not.toMatch(/score|rating|health/i)
  })

  it('the summary text counts outcomes', () => {
    expect(riskSummaryText({ finding: 2, clear: 2, not_evaluated: 1, loading: 0 })).toBe('2 findings · 1 not evaluated · 2 no finding')
    expect(riskSummaryText({ finding: 1, clear: 0, not_evaluated: 0, loading: 0 })).toBe('1 finding')
    expect(riskSummaryText({ finding: 0, clear: 5, not_evaluated: 0, loading: 0 })).toBe('5 no finding')
    expect(riskSummaryText({ finding: 0, clear: 0, not_evaluated: 0, loading: 5 })).toBe('Loading')
  })
})

// ── 11. Display text ─────────────────────────────────────────────────────────

describe('loading "—" · failed "Unavailable" · zero "0" · missing "Not set" · working "Not approved"', () => {
  const money = (n) => `$${n.toFixed(2)}`
  const pct = (n) => `${n}%`
  const text = (figure, kind = FIGURE_KIND.MONEY) => portfolioFigureText(figure, kind, money, pct)

  it('each state has its own word', () => {
    expect(text({ state: FIGURE_STATE.LOADING, value: null })).toBe('—')
    expect(text(undefined)).toBe('—')
    expect(text({ state: FIGURE_STATE.UNAVAILABLE, value: null })).toBe('Unavailable')
    expect(text({ state: FIGURE_STATE.READY, value: 0 })).toBe('$0.00')
    expect(text({ state: FIGURE_STATE.READY, value: -12.5 })).toBe('$-12.50')
    expect(text({ state: PORTFOLIO_FIGURE_STATE.NOT_SET, value: null })).toBe('Not set')
    expect(text({ state: PORTFOLIO_FIGURE_STATE.NOT_APPROVED, value: null, workingValue: 7000 })).toBe('Not approved')
    expect(text({ state: FIGURE_STATE.READY, value: null }, FIGURE_KIND.PERCENT)).toBe('Not calculable')
    expect(text({ state: FIGURE_STATE.READY, value: null })).toBe('Unavailable')
    expect(text({ state: FIGURE_STATE.READY, value: 12.5 }, FIGURE_KIND.PERCENT)).toBe('12.5%')
    expect(text({ state: 'something-new', value: 5 })).toBe('Unavailable')
  })

  it('a subtotal is a number only when complete', () => {
    const sub = (s, kind = FIGURE_KIND.MONEY) => portfolioSubtotalText(s, kind, money, pct)
    expect(sub({ state: SUBTOTAL_STATE.COMPLETE, value: 0 })).toBe('$0.00')
    expect(sub({ state: SUBTOTAL_STATE.INCOMPLETE, value: null })).toBe('Incomplete')
    expect(sub({ state: SUBTOTAL_STATE.LOADING, value: null })).toBe('—')
    expect(sub({ state: SUBTOTAL_STATE.COMPLETE, value: null })).toBe('Incomplete')
    expect(sub(undefined)).toBe('—')
    expect(portfolioSubtotalNote({ state: SUBTOTAL_STATE.COMPLETE, total: 3 })).toBe('All 3 projects')
    expect(portfolioSubtotalNote({ state: SUBTOTAL_STATE.COMPLETE, total: 1 })).toBe('All 1 project')
  })
})

// ── 12. Read times and the row cache ─────────────────────────────────────────

describe('read times are a window, and settled rows are not rebuilt', () => {
  it('reports the window in which the projects were read', async () => {
    const a = { ...(await resultOf(readyProject())), loadedAt: new Date(2026, 10, 20, 9, 0, 1) }
    const b = { ...(await resultOf(readyProject())), loadedAt: new Date(2026, 10, 20, 9, 0, 9) }
    const portfolio = build([proj('a'), proj('b')], { a, b })
    expect(portfolio.loadedFrom).toEqual(a.loadedAt)
    expect(portfolio.loadedTo).toEqual(b.loadedAt)
    expect(build([proj('a')], {}).loadedFrom).toBeNull()
  })

  it('the same settled result yields the same row object; a new day or project does not', async () => {
    const result = await resultOf(readyProject())
    const project = proj('a')
    const first = portfolioRow({ project, company: COMPANY, result, now: NOW })
    expect(portfolioRow({ project, company: COMPANY, result, now: new Date(2026, 10, 20, 17, 0) })).toBe(first)
    expect(portfolioRow({ project, company: COMPANY, result, now: new Date(2026, 10, 21) })).not.toBe(first)
    expect(portfolioRow({ project: { ...project }, company: COMPANY, result, now: NOW })).not.toBe(first)
  })
})

// ── 13. CSV ──────────────────────────────────────────────────────────────────

const parse = (csv) => csv.trimEnd().split('\r\n')
const GENERATED = new Date('2026-11-20T01:02:03.000Z')

describe('CSV export', () => {
  const mixed = async () => build(
    [proj('a'), proj('w'), proj('n', { currency: 'NZD' })],
    { a: await resultOf(readyProject()), w: await resultOf(working()), n: await resultOf((() => {
      const p = scaled(); p.budgetApprovals[0].currency = 'NZD'; p.budgetApprovalSnapshots[0].currency = 'NZD'; return p
    })()) },
  )
  const csvOf = async (portfolio, companyName = 'Acme Builders') =>
    portfolioReportCsv(portfolio ?? await mixed(), { generatedAt: GENERATED, companyName })

  it('states scope, currencies, generation time, the read window and coverage', async () => {
    const lines = parse(await csvOf())
    expect(lines[0]).toBe('"Constrap Portfolio Report"')
    expect(lines[1]).toBe('"Company","Acme Builders"')
    expect(lines[2]).toBe('"Scope","Open projects (3 projects)"')
    expect(lines[3]).toContain('"Currencies","AUD, NZD"')
    expect(lines[3]).toContain('No amount is converted and no amount is added across currencies.')
    expect(lines[4]).toContain('"Generated","2026-11-20T01:02:03.000Z"')
    expect(lines[5]).toContain('not one atomic snapshot')
    expect(lines[6]).toContain('"Financial coverage","COMPLETE"')
  })

  it('every project and subtotal line carries its currency', async () => {
    const lines = parse(await csvOf())
    const projectLines = lines.filter(l => l.startsWith('"PROJECT"'))
    const subtotalLines = lines.filter(l => l.startsWith('"SUBTOTAL"'))
    expect(projectLines).toHaveLength(3)
    expect(subtotalLines).toHaveLength(2)
    expect(projectLines.filter(l => l.startsWith('"PROJECT","AUD","Project currency"'))).toHaveLength(2)
    expect(projectLines.filter(l => l.startsWith('"PROJECT","NZD","Project currency"'))).toHaveLength(1)
    expect(subtotalLines[0].startsWith('"SUBTOTAL","AUD","","AUD subtotal"')).toBe(true)
    expect(subtotalLines[1].startsWith('"SUBTOTAL","NZD","","NZD subtotal"')).toBe(true)
  })

  it('a project line: identity, status, budget source, 2-decimal numbers, indicators, completeness', async () => {
    const line = parse(await csvOf()).find(l => l.includes('"Project a"'))
    expect(line).toContain('"Project a","In Progress","Approved version 1",12000.00,7000.00,6000.00,0.00,6000.00,1000.00,6000.00,50.00,1490.00,2200.00,0.00,')
    expect(line).toContain('"COMPLETE"')
    expect(line).toContain('"FINDING"')
    expect(line).toContain('"NO FINDING"')
    expect(line).toContain(LOADED_AT.toISOString())
  })

  it('a working budget exports NOT APPROVED, with the working amount in its own labelled column', async () => {
    const lines = parse(await csvOf())
    const header = lines.find(l => l.startsWith('"Row type"'))
    expect(header).toContain('"Working budget (not approved)","Variance to working budget (not approved)"')
    const line = lines.find(l => l.includes('"Project w"'))
    expect(line).toContain('"Working budget (not approved)",12000.00,"NOT APPROVED",6000.00,0.00,6000.00,"NOT APPROVED",6000.00,50.00,1490.00,2200.00,0.00,7000.00,1000.00,')
  })

  it('an incomplete subtotal exports INCOMPLETE — never zero, never the partial sum', async () => {
    const lines = parse(await csvOf())
    const aud = lines.find(l => l.startsWith('"SUBTOTAL","AUD"'))
    //                                     contract  budget       actual   committed FFC  variance     profit   margin
    expect(aud).toContain('"AUD subtotal","","",24000.00,"INCOMPLETE",12000.00,0.00,12000.00,"INCOMPLETE",12000.00,50.00,2980.00,4400.00,0.00,"","",2,')
    expect(aud).toContain('Approved Budget: 1 of 2 projects (1 budget not approved)')
    expect(aud).not.toContain(',7000.00,')
    expect(aud).not.toContain(',14000.00,')
    expect(portfolioSubtotalCsvValue({ state: SUBTOTAL_STATE.INCOMPLETE, value: null })).toBe('INCOMPLETE')
    expect(portfolioSubtotalCsvValue({ state: SUBTOTAL_STATE.LOADING, value: null })).toBe('INCOMPLETE')
    expect(portfolioSubtotalCsvValue(undefined)).toBe('INCOMPLETE')
    expect(portfolioSubtotalCsvValue({ state: SUBTOTAL_STATE.NOT_CALCULABLE, value: null })).toBe('NOT CALCULABLE')
    expect(portfolioSubtotalCsvValue({ state: SUBTOTAL_STATE.COMPLETE, value: 0 })).toEqual({ csvNumber: '0.00' })
  })

  it('failed records export UNAVAILABLE, the failed source, and INCOMPLETE coverage', async () => {
    const portfolio = build(
      [proj('a'), proj('f')],
      { a: await resultOf(readyProject()), f: await resultOf(readyProject(), { fail: c => c.collection === 'supplierInvoices' }) },
    )
    const lines = parse(await csvOf(portfolio))
    expect(lines[6]).toContain('"Financial coverage","INCOMPLETE","1 of 2 projects have records that could not be loaded.')
    const line = lines.find(l => l.includes('"Project f"'))
    expect(line).toContain('12000.00,7000.00,"UNAVAILABLE","UNAVAILABLE","UNAVAILABLE","UNAVAILABLE","UNAVAILABLE","UNAVAILABLE","UNAVAILABLE",2200.00')
    expect(line).toContain('"INCOMPLETE","Supplier Invoices"')
    expect(line).toContain('"NOT EVALUATED"')
    const sub = lines.find(l => l.startsWith('"SUBTOTAL"'))
    expect(sub).toContain('24000.00,14000.00,"INCOMPLETE","INCOMPLETE","INCOMPLETE","INCOMPLETE","INCOMPLETE","INCOMPLETE","INCOMPLETE",4400.00')
    expect(sub).toContain('Actual Cost: 1 of 2 projects (1 unavailable)')
  })

  it('figure markers: every state is a word', () => {
    const M = PORTFOLIO_CSV_MARKER
    expect(portfolioFigureCsvValue(undefined)).toBe(M.UNAVAILABLE)
    expect(portfolioFigureCsvValue({ state: FIGURE_STATE.LOADING, value: null })).toBe(M.UNAVAILABLE)
    expect(portfolioFigureCsvValue({ state: FIGURE_STATE.UNAVAILABLE, value: null })).toBe(M.UNAVAILABLE)
    expect(portfolioFigureCsvValue({ state: PORTFOLIO_FIGURE_STATE.NOT_SET, value: null })).toBe(M.NOT_SET)
    expect(portfolioFigureCsvValue({ state: PORTFOLIO_FIGURE_STATE.NOT_APPROVED, value: null, workingValue: 5 })).toBe(M.NOT_APPROVED)
    expect(portfolioFigureCsvValue({ state: FIGURE_STATE.READY, value: null }, FIGURE_KIND.PERCENT)).toBe(M.NOT_CALCULABLE)
    expect(portfolioFigureCsvValue({ state: FIGURE_STATE.READY, value: 0 })).toEqual({ csvNumber: '0.00' })
    expect(portfolioFigureCsvValue({ state: FIGURE_STATE.READY, value: -1899.9 })).toEqual({ csvNumber: '-1899.90' })
  })

  it('a legacy inherited currency is identified on its line', async () => {
    const portfolio = build([{ id: 'l', name: 'Legacy', status: 'Planning' }], { l: await resultOf(readyProject()) })
    const line = parse(await csvOf(portfolio)).find(l => l.includes('"Legacy"'))
    expect(line.startsWith('"PROJECT","AUD","Inherited from company (no currency stored on the project)","Legacy","Planning"')).toBe(true)
  })

  it('neutralises spreadsheet formulas in project, status and company names', async () => {
    const hostile = [
      proj('h1', { name: '=HYPERLINK("http://evil","x")' }),
      proj('h2', { name: '+SUM(A1:A9)', status: '@cmd' }),
      proj('h3', { name: '-2+3' }),
      proj('h4', { name: '\t=1+1' }),
      proj('h5', { name: 'Tower "B", Stage 2' }),
    ]
    const results = {}
    for (const p of hostile) results[p.id] = await resultOf(readyProject())
    const csv = await csvOf(build(hostile, results), '=cmd|\' /C calc\'!A0')
    expect(csv).toContain(`"Company","'=cmd|' /C calc'!A0"`)
    expect(csv).toContain(`"'=HYPERLINK(""http://evil"",""x"")"`)
    expect(csv).toContain(`"'+SUM(A1:A9)","'@cmd"`)
    expect(csv).toContain(`"'-2+3"`)
    expect(csv).toContain(`"'\t=1+1"`)
    expect(csv).toContain(`"Tower ""B"", Stage 2"`)
    // No text cell begins with a formula trigger; negative numbers are unquoted numbers.
    for (const cell of csv.match(/"(?:[^"]|"")*"/g)) {
      expect(cell).not.toMatch(/^"[=+\-@\t\r]/)
    }
  })

  it('goes through lib/csv.js only, and serialises the model — never a raw record', () => {
    const code = stripComments(read('lib/portfolioReportCsv.js'))
    expect(code).toContain(`import { csvRows, csvMoney, filenameSlug } from './csv'`)
    expect(code).toContain('return csvRows(rows)')
    expect(code).not.toMatch(/\.join\(','\)/)
    for (const raw of ['purchaseOrders', 'supplierInvoices', 'clientInvoices', 'sources']) expect(code).not.toContain(raw)
  })

  it('refuses a loading or empty portfolio, and a missing generation time', async () => {
    const loading = build([proj('a'), proj('b')], { a: await resultOf(readyProject()) })
    expect(() => portfolioReportCsv(loading, { generatedAt: GENERATED })).toThrow(/still loading or empty/)
    expect(() => portfolioReportCsv(build([], {}), { generatedAt: GENERATED })).toThrow(/still loading or empty/)
    expect(() => portfolioReportCsv(null, { generatedAt: GENERATED })).toThrow()
    const ok = build([proj('a')], { a: await resultOf(readyProject()) })
    expect(() => portfolioReportCsv(ok, {})).toThrow(/generation time/)
    expect(() => portfolioReportCsv(ok, { generatedAt: new Date('nope') })).toThrow(/generation time/)
  })

  it('names the file after the company and the local date', () => {
    const at = new Date(2026, 10, 20, 9, 0)
    expect(portfolioReportFilename('Acme Builders Pty Ltd', at)).toBe('constrap-portfolio-report-acme-builders-pty-ltd-2026-11-20.csv')
    expect(portfolioReportFilename('', at)).toBe('constrap-portfolio-report-company-2026-11-20.csv')
    expect(portfolioReportFilename('../../etc/passwd', at)).toBe('constrap-portfolio-report-etc-passwd-2026-11-20.csv')
  })
})
