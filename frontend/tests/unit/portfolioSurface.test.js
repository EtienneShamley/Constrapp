import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { NAV, navFor } from '../../src/lib/nav'
import { FINANCIAL_ROLES } from '../../src/lib/margin'
import { EXTERNAL_ROLE_VALUES } from '../../src/lib/team'

// ── L2-C Portfolio Report — the page surface (ADR-78) ────────────────────────
//
// Structural contracts of the page, its navigation and its place beside the
// Dashboard. These read SOURCE: the unit runner is plain Node with no jsdom
// (ADR-26), and what is asserted here is structure — who mounts the loader,
// what the page may import, what the print and responsive layouts contain.
// Behaviour of the figures themselves is in portfolioReport.test.js.
//
// ⚠️ The role gate asserted here is UX. The enforced boundary is Firestore
// Security Rules, which already restrict every path the loader reads to the
// financial roles of the caller's own company (tests/rules/
// externalRoles.rules.test.js — get, list, other-company and collection-group
// denial for each of them). L2-C changes no rule.

const read = (rel) => readFileSync(fileURLToPath(new URL(`../../src/${rel}`, import.meta.url)), 'utf8')
const stripComments = (src) =>
  src.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

const page = stripComments(read('pages/PortfolioReport.jsx'))
const groupView = stripComments(read('pages/portfolio/CurrencyGroup.jsx'))

// ── 1. Navigation and route ──────────────────────────────────────────────────

describe('navigation: Portfolio is offered to financial roles only', () => {
  const entry = NAV.find(n => n.to === '/portfolio')

  it('the entry exists and its role list IS the financial roles', () => {
    expect(entry).toMatchObject({ label: 'Portfolio' })
    expect([...entry.roles].sort()).toEqual([...FINANCIAL_ROLES].sort())
    expect(FINANCIAL_ROLES).toEqual(['company_admin', 'project_manager', 'qs'])
  })

  it('each financial role is offered it', () => {
    for (const role of FINANCIAL_ROLES) expect(navFor(role).map(n => n.to)).toContain('/portfolio')
  })

  it('external, unknown and still-loading roles are not', () => {
    for (const role of [...EXTERNAL_ROLE_VALUES, 'super_admin', 'auditor', '', null, undefined]) {
      expect(navFor(role).map(n => n.to)).not.toContain('/portfolio')
    }
  })

  it('Dashboard and Projects are offered to everyone; the contact pages to the internal roles only (M2-A2)', () => {
    for (const role of ['company_admin', 'project_manager', 'qs']) {
      expect(navFor(role).map(n => n.to)).toEqual(['/', '/projects', '/portfolio', '/contacts', '/subcontractors'])
    }
    for (const role of ['subcontractor', 'client', 'super_admin', undefined]) {
      expect(navFor(role).map(n => n.to)).toEqual(['/', '/projects'])
    }
    expect(NAV.filter(n => n.roles).map(n => n.to)).toEqual(['/portfolio', '/contacts', '/subcontractors'])
  })

  it('the sidebar renders the role-filtered list', () => {
    const sidebar = stripComments(read('layouts/Sidebar.jsx'))
    expect(sidebar).toContain('navFor(profile?.role).map(')
    expect(sidebar).not.toContain('NAV.map(')
  })

  it('the route is inside the authenticated, membership-gated shell', () => {
    const app = stripComments(read('App.jsx'))
    expect(app).toContain(`<Route path="portfolio"      element={<PortfolioReport />} />`)
    const shell = app.indexOf('<Route element={<AppShell />}>')
    expect(shell).toBeGreaterThan(app.indexOf('<Route element={<MembershipGate />}>'))
    expect(app.indexOf('path="portfolio"')).toBeGreaterThan(shell)
  })
})

// ── 2. The role gate: no financial read for anyone else ──────────────────────

describe('the loader is mounted for financial roles only', () => {
  const gate = page.slice(page.indexOf('export default function PortfolioReport()'))
  const view = page.slice(page.indexOf('function PortfolioView('), page.indexOf('export default function PortfolioReport()'))

  it('the default export gates on isFinancialRole before it renders the view', () => {
    const check = gate.indexOf('if (!isFinancialRole(profile?.role))')
    const render = gate.indexOf('<PortfolioView ')
    expect(check).toBeGreaterThan(-1)
    expect(render).toBeGreaterThan(check)
    // While the profile is loading the role is unknown: nothing is mounted.
    expect(gate.indexOf('if (profileLoading)')).toBeGreaterThan(-1)
    expect(gate.indexOf('if (profileLoading)')).toBeLessThan(check)
  })

  it('the gate itself never calls the loader — only the view does', () => {
    expect(gate).not.toContain('usePortfolioReport(')
    expect(view).toContain('usePortfolioReport(projectIds)')
    expect(page.match(/usePortfolioReport\(/g)).toHaveLength(1)
  })

  it('the restricted notice names the roles and the real boundary', () => {
    expect(gate).toContain('The Portfolio Report is restricted')
    expect(gate).toContain('enforced by Firestore Security Rules')
  })

  it('no page file touches Firestore directly (hooks-only access)', () => {
    for (const src of [page, groupView]) {
      expect(src).not.toMatch(/from 'firebase/)
      expect(src).not.toContain('lib/firebase')
    }
  })

  it('the loader is company-scoped by the signed-in member\'s own company', () => {
    const hook = stripComments(read('hooks/usePortfolioReport.jsx'))
    expect(hook).toContain('const { company } = useCompany()')
    expect(hook).toContain('if (!key) return')
  })
})

// ── 3. The page computes nothing ─────────────────────────────────────────────

describe('the page renders the model and performs no arithmetic', () => {
  it('builds its figures only through lib/portfolioReport.js', () => {
    expect(page).toContain('buildPortfolioReport({ projects, company, results, includeCompleted, now })')
  })

  it('neither page file sums, averages or converts', () => {
    for (const src of [page, groupView]) {
      expect(src).not.toContain('.reduce(')
      expect(src).not.toMatch(/Math\.(round|floor|ceil)/)
      expect(src).not.toMatch(/exchange|fxRate|convert\(/i)
      expect(src).not.toContain('baseCurrency')
    }
  })

  it('there is no chart, trend or cash-flow forecast', () => {
    for (const src of [page, groupView]) {
      expect(src).not.toMatch(/recharts|<svg|Chart/)
      expect(src).not.toContain('cashFlow')
    }
  })

  it('a project figure is formatted in the GROUP currency only', () => {
    expect(groupView).toContain('const ccy = group.currencyCode')
    expect(groupView).toContain('formatCurrency(n, ccy, { precise: true })')
    expect(groupView.match(/formatCurrency\(/g)).toHaveLength(1)
    expect(page).not.toContain('formatCurrency(')
  })
})

// ── 4. Controls, states and honest wording ───────────────────────────────────

describe('controls and states', () => {
  it('scope filter, Refresh, CSV and print are present', () => {
    expect(page).toContain('Include completed')
    expect(page).toContain('onChange={(e) => setIncludeCompleted(e.target.checked)}')
    expect(page).toContain('useState(false)')
    expect(page).toContain('<Btn variant="ghost" onClick={handleRefresh}>Refresh</Btn>')
    expect(page).toContain('<Btn variant="ghost" onClick={handleExport} disabled={!exportable}>Export CSV</Btn>')
    expect(page).toContain('<Btn variant="ghost" onClick={handlePrint} disabled={!exportable}>Print / Save as PDF</Btn>')
  })

  it('export and print are disabled until every project has settled', () => {
    expect(page).toContain('const exportable = isPortfolioExportable(portfolio)')
  })

  it('the CSV is saved through the app\'s one object-URL path', () => {
    expect(page).toContain(`import { saveBlob } from '../lib/fileBlob'`)
    expect(page).toContain('saveBlob({ blob, fileName: filename })')
    expect(page).not.toContain('createObjectURL')
  })

  it('a failed project list is "unavailable", not an empty portfolio', () => {
    expect(page).toContain('PROJECTS_LIST_STATE.UNAVAILABLE')
    expect(page).toContain('This is not an empty portfolio')
    expect(page).toContain('PROJECTS_LIST_STATE.EMPTY')
    expect(page).toContain('No open projects')
  })

  it('says it is a point-in-time read, read over a window — not live, not atomic', () => {
    expect(page).toContain('Records read between')
    expect(page).toContain('not a single-instant snapshot')
    expect(page).toContain('Not live, and not an accounting cut-off, period close or saved report')
  })

  it('states incomplete coverage, working budgets and unset contracts in words', () => {
    expect(page).toContain('portfolio.coverage === COMPLETENESS.INCOMPLETE')
    expect(page).toContain('Financial coverage is incomplete')
    expect(page).toContain('never zero')
    expect(page).toContain('A working budget is not an Approved Budget')
    expect(page).toContain('no contract value')
  })

  it('counts that need every project are "—" while loading, never a running total', () => {
    expect(page).toContain(`const settled = (n) => (portfolio.loading ? '—' : n)`)
    expect(page).toContain('Project counts · all currencies · no money')
  })

  it('"not evaluated" is explained as not a clear result', () => {
    expect(page).toContain('it is not a clear result')
    expect(page).toContain('Counts of projects, not scores')
  })

  it('loading progress is announced politely', () => {
    expect(page).toContain('role="status" aria-live="polite"')
  })
})

// ── 5. Currency groups: table, cards, subtotals ──────────────────────────────

describe('currency group layout', () => {
  it('names the currency in the heading, the subtotal panel and the subtotal row', () => {
    expect(groupView).toContain('{ccy} <span')
    expect(groupView).toContain('{ccy} subtotals ·')
    expect(groupView).toContain('{ccy} subtotal')
    expect(groupView).toContain('nothing is converted')
  })

  it('subtotals are visually separate from project figures', () => {
    // The accent-edged panel, and a heavier, labelled footer row.
    expect(groupView).toContain('border-l-4 border-l-brand-accent')
    expect(groupView).toContain('<tfoot>')
    expect(groupView).toContain('border-t-2 border-brand-accent/50')
    expect(groupView).toContain('not a project')
  })

  it('a table from lg (and always in print); stacked cards below lg (never in print)', () => {
    expect(groupView).toContain('hidden overflow-x-auto border-t border-brand-border lg:block print:block')
    expect(groupView).toContain('lg:hidden print:hidden')
    expect(groupView).toContain('grid grid-cols-2')
    expect(groupView).toContain('min-h-[44px]')
  })

  it('the table is accessible: caption, column and row headers', () => {
    expect(groupView).toContain('<caption className="sr-only">')
    expect(groupView).toContain('<th scope="col"')
    expect(groupView).toContain('<th scope="row"')
    expect(groupView).toContain('aria-labelledby={headingId}')
  })

  it('every project drills down to its Commercial Report, and indicators to their tab', () => {
    expect(groupView).toContain('to={`/projects/${row.projectId}/reports`}')
    expect(groupView).toContain('to={`/projects/${row.projectId}/${ind.link.to}`}')
  })

  it('indicators use a native, keyboard-operable disclosure and state their outcome in words', () => {
    expect(groupView).toContain('<details')
    expect(groupView).toContain('<summary')
    expect(groupView).toContain('{RISK_LABELS[ind.risk]}')
  })

  it('a working figure is labelled "Working" beside "Not approved"; a failure names its sources', () => {
    expect(groupView).toContain(`Working {spec.key === 'varianceToBudget' ? 'variance' : 'budget'} {fmt(figure.workingValue)}`)
    expect(groupView).toContain('Could not load: {failedSourcesText(figure.failedSources)}')
  })

  it('an inherited currency is marked on the row', () => {
    expect(groupView).toContain(`row.currencyInherited ? ' · inherited from company' : ''`)
  })

  it('tokens only — no hex colour and no inline style object', () => {
    for (const src of [page, groupView]) {
      expect(src).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
      expect(src).not.toContain('style={{')
    }
  })
})

// ── 6. Print ─────────────────────────────────────────────────────────────────

describe('print reuses the Commercial Report print layout', () => {
  const css = read('index.css')

  it('the article carries the report classes the print stylesheet targets', () => {
    expect(page).toContain('className="commercial-report portfolio-report')
    expect(css).toContain('.commercial-report { page: commercial-report; }')
    expect(css).toContain('.commercial-report .report-controls { display: none !important; }')
    expect(css).toContain('.commercial-report .report-table-wrap { overflow: visible !important; }')
  })

  it('controls are excluded from print; scope, currencies, time and coverage are not', () => {
    const header = page.slice(page.indexOf('<Card className="report-header">'), page.indexOf('{counts.projects === 0 ?'))
    const controls = header.slice(header.indexOf('<div className="report-controls'), header.indexOf('</Btn>\n          </div>'))
    expect(controls).toContain('Include completed')
    expect(controls).toContain('Refresh')
    const printed = header.replace(controls, '')
    expect(printed).toContain('portfolioScopeText(portfolio.scope)')
    expect(printed).toContain(`portfolio.currencies.join(', ')`)
    expect(printed).toContain('Generated <time dateTime={generatedAt.toISOString()}>')
    expect(printed).toContain('Records read between')
    // The incomplete-coverage notice is NOT inside a .report-controls element.
    const notice = header.slice(header.indexOf('{portfolio.coverage === COMPLETENESS.INCOMPLETE'))
    expect(notice.slice(0, notice.indexOf('Financial coverage is incomplete'))).not.toContain('report-controls')
  })

  it('print stamps the moment it was produced', () => {
    expect(page).toContain('flushSync(() => setGeneratedAt(new Date()))')
    expect(page).toContain('window.print()')
  })
})

// ── 7. The Dashboard is untouched (ADR-42 still binds it) ────────────────────

describe('ADR-78 is an exception for the Portfolio page only', () => {
  it('no Dashboard file imports the portfolio model, loader or page', () => {
    for (const f of [
      'pages/Dashboard.jsx', 'pages/dashboard/PortfolioSummary.jsx', 'pages/dashboard/ProjectRegister.jsx',
      'pages/dashboard/ProjectSnapshot.jsx', 'pages/dashboard/CostPerformanceChart.jsx', 'pages/dashboard/KpiCard.jsx',
      'pages/dashboard/ProgrammePanel.jsx', 'lib/projectSnapshot.js', 'lib/projects.js',
    ]) {
      const src = read(f)
      expect(src).not.toContain('portfolioReport')
      expect(src).not.toContain('portfolioSources')
      expect(src).not.toContain('usePortfolioReport')
    }
  })

  it('the portfolio model is imported by the Portfolio page, its group view and its export only', () => {
    expect(page).toContain(`from '../lib/portfolioReport'`)
    expect(groupView).toContain(`from '../../lib/portfolioReport'`)
    expect(read('lib/portfolioReportCsv.js')).toContain(`from './portfolioReport'`)
    expect(read('lib/commercialReport.js')).not.toContain('portfolio')
  })
})
