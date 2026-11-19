import { useMemo, useState } from 'react'
import { flushSync } from 'react-dom'
import { Link } from 'react-router-dom'
import Card from '../components/Card'
import Btn from '../components/Btn'
import { isFinancialRole } from '../lib/margin'
import { PROJECTS_LIST_STATE, projectsListState } from '../lib/projects'
import {
  buildPortfolioReport, portfolioScope, isPortfolioExportable, portfolioScopeText,
  COMPLETENESS, PORTFOLIO_FIGURES, PORTFOLIO_FIGURE_NOTES,
} from '../lib/portfolioReport'
import { portfolioReportCsv, portfolioReportFilename } from '../lib/portfolioReportCsv'
import { saveBlob } from '../lib/fileBlob'
import { useProfile } from '../hooks/useProfile'
import { useCompany } from '../hooks/useCompany'
import { useProjects } from '../hooks/useProjects'
import { useLocalToday } from '../hooks/useLocalToday'
import { usePortfolioReport } from '../hooks/usePortfolioReport'
import CurrencyGroup from './portfolio/CurrencyGroup'

// ── Portfolio Report (L2-C, ADR-78) ──────────────────────────────────────────
//
// The company-wide commercial overview: one row per project, GROUPED BY THE
// PROJECT'S OWN CURRENCY, with subtotals inside one currency only. This page
// is the single, narrow exception to ADR-42 Decision 2 ("no portfolio money"),
// which still binds the Dashboard.
//
// ⚠️ THE ROLE GATE IS THE DEFAULT EXPORT, NOT THE VIEW. `PortfolioReport`
// renders `PortfolioView` only for financial roles, and the view is what calls
// usePortfolioReport — so a subcontractor or client never ISSUES a financial
// read (not issued-and-hidden). That is UX: Firestore Security Rules are the
// enforced boundary, and they already restrict every path read here to the
// financial roles of the caller's own company.
//
// Nothing on this page is computed here. Every figure, subtotal, state and
// label comes from lib/portfolioReport.js, which composes the L2-A Commercial
// Report model and the financial Constrap PULSE™ indicators. There is no
// chart, no trend and no cash-flow forecast: none has an authoritative source
// across projects.
//
// The data is a POINT-IN-TIME READ, not a live view and not one atomic
// snapshot: each project is read separately (three at a time), so the header
// states the window in which the records were read. Refresh reads again.

const stamp = (date) => date.toLocaleString('en-AU', {
  day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
})
const clock = (date) => date.toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit', second: '2-digit' })

// Saved through lib/fileBlob.js → saveBlob, the app's ONE object-URL path. A
// UTF-8 BOM lets spreadsheet applications detect the encoding.
function downloadCsv(text, filename) {
  const blob = new Blob(['﻿', text], { type: 'text/csv;charset=utf-8' })
  saveBlob({ blob, fileName: filename })
}

function Count({ label, value, tone = 'text-brand-text' }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10.5px] font-bold uppercase tracking-[0.4px] text-brand-muted">{label}</dt>
      <dd className={`m-0 mt-0.5 text-[20px] font-black leading-none tabular-nums ${tone}`}>{value}</dd>
    </div>
  )
}

function PortfolioView({ projects, company }) {
  const [includeCompleted, setIncludeCompleted] = useState(false)
  const now = useLocalToday()

  const scope = useMemo(() => portfolioScope(projects, { includeCompleted }), [projects, includeCompleted])
  const projectIds = useMemo(() => scope.inScope.map(p => p.id), [scope])

  // The ONLY financial reads on this page — one-shot, three projects at a time.
  const { results, refresh } = usePortfolioReport(projectIds)

  const portfolio = useMemo(
    () => buildPortfolioReport({ projects, company, results, includeCompleted, now }),
    [projects, company, results, includeCompleted, now],
  )

  const [generatedAt, setGeneratedAt] = useState(() => new Date())
  const [exportError, setExportError] = useState(null)
  const exportable = isPortfolioExportable(portfolio)
  const companyName = company?.name ?? ''
  const { counts } = portfolio
  const loaded = counts.projects - counts.loading

  function handleExport() {
    setExportError(null)
    try {
      const at = new Date()
      downloadCsv(portfolioReportCsv(portfolio, { generatedAt: at, companyName }), portfolioReportFilename(companyName, at))
      setGeneratedAt(at)
    } catch {
      setExportError('The CSV could not be generated. Wait for every project to load and try again.')
    }
  }

  // Refresh discards the current read and reads every in-scope project again.
  function handleRefresh() {
    setExportError(null)
    setGeneratedAt(new Date())
    refresh()
  }

  function handlePrint() {
    flushSync(() => setGeneratedAt(new Date()))
    window.print()
  }

  // Counts that need every project settled are "—" until then, never a
  // running number that reads as final.
  const settled = (n) => (portfolio.loading ? '—' : n)

  return (
    <article className="commercial-report portfolio-report flex max-w-[1680px] flex-col gap-4" aria-labelledby="portfolio-title">
      <Card className="report-header">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <p className="m-0 text-[11px] font-bold uppercase tracking-[0.4px] text-brand-accent">Constrap · Portfolio Report</p>
            <h1 id="portfolio-title" className="m-0 mt-1 break-words text-xl font-semibold text-brand-text">
              {companyName || 'Portfolio'}
            </h1>
            <p className="m-0 mt-1 text-[12.5px] text-brand-text-soft">
              Scope <span className="font-bold text-brand-text">{portfolioScopeText(portfolio.scope)}</span>
              {portfolio.currencies.length > 0 && (
                <>
                  <span aria-hidden="true"> · </span>
                  {portfolio.currencies.length === 1 ? 'Currency' : 'Currencies'}{' '}
                  <span className="font-bold text-brand-text">{portfolio.currencies.join(', ')}</span>
                  {portfolio.currencies.length > 1 && ' — reported separately, never combined'}
                </>
              )}
            </p>
            <p className="m-0 mt-1 text-[12px] text-brand-muted">
              Generated <time dateTime={generatedAt.toISOString()}>{stamp(generatedAt)}</time>.
              {portfolio.loadedFrom && portfolio.loadedTo && !portfolio.loading && (
                <>
                  {' '}Records read between{' '}
                  <time dateTime={portfolio.loadedFrom.toISOString()}>{clock(portfolio.loadedFrom)}</time> and{' '}
                  <time dateTime={portfolio.loadedTo.toISOString()}>{clock(portfolio.loadedTo)}</time>, one project at a
                  time — not a single-instant snapshot.
                </>
              )}
              {' '}Not live, and not an accounting cut-off, period close or saved report. Use Refresh to read again.
            </p>
          </div>
          <div className="report-controls flex shrink-0 flex-wrap items-center gap-2">
            <label className="flex min-h-[44px] cursor-pointer items-center gap-2 rounded-lg border border-brand-border px-3 text-[12.5px] font-semibold text-brand-text-soft">
              <input
                type="checkbox"
                className="h-4 w-4 accent-brand-accent"
                checked={includeCompleted}
                onChange={(e) => setIncludeCompleted(e.target.checked)}
              />
              Include completed{scope.completedCount > 0 ? ` (${scope.completedCount})` : ''}
            </label>
            <Btn variant="ghost" onClick={handleRefresh}>Refresh</Btn>
            <Btn variant="ghost" onClick={handleExport} disabled={!exportable}>Export CSV</Btn>
            <Btn variant="ghost" onClick={handlePrint} disabled={!exportable}>Print / Save as PDF</Btn>
          </div>
        </div>

        <p className="report-controls m-0 mt-3 text-[12px] text-brand-muted" role="status" aria-live="polite">
          {portfolio.loading
            ? `Loading project records… ${loaded} of ${counts.projects} projects read. Export and print are available once every project has loaded.`
            : counts.projects > 0 ? `All ${counts.projects} ${counts.projects === 1 ? 'project has' : 'projects have'} been read.` : ''}
        </p>
        {exportError && <p className="report-controls m-0 mt-2 text-[12px] text-brand-red" role="alert">{exportError}</p>}

        {portfolio.coverage === COMPLETENESS.INCOMPLETE && (
          <p className="m-0 mt-3 text-[12.5px] text-brand-amber" role="status">
            Financial coverage is incomplete: records could not be loaded for {counts.incomplete} of {counts.projects}{' '}
            {counts.projects === 1 ? 'project' : 'projects'}. Their affected figures show “Unavailable” — never zero —
            and any currency subtotal that needs them is not totalled.
          </p>
        )}
        {!portfolio.loading && counts.workingBudget > 0 && (
          <p className="m-0 mt-2 text-[12.5px] text-brand-text-soft">
            {counts.workingBudget} {counts.workingBudget === 1 ? 'project has' : 'projects have'} a working budget
            only. A working budget is not an Approved Budget, so those rows show “Not approved” and the budget and
            variance subtotals of their currency are not totalled.
          </p>
        )}
        {!portfolio.loading && counts.contractNotSet > 0 && (
          <p className="m-0 mt-2 text-[12.5px] text-brand-text-soft">
            {counts.contractNotSet} {counts.contractNotSet === 1 ? 'project has' : 'projects have'} no contract value
            set, so contract, profit and margin show “Not set” and those subtotals are not totalled.
          </p>
        )}
      </Card>

      {counts.projects === 0 ? (
        <Card>
          <p className="m-0 text-[13px] font-semibold text-brand-text">No open projects</p>
          <p className="m-0 mt-1 text-[12.5px] text-brand-muted">
            {scope.completedCount > 0
              ? `${scope.completedCount} completed ${scope.completedCount === 1 ? 'project is' : 'projects are'} not included. Tick “Include completed” to report on ${scope.completedCount === 1 ? 'it' : 'them'}.`
              : 'There is nothing to report on yet.'}
          </p>
        </Card>
      ) : (
        <>
          {/* Non-financial counts — the only thing combined across currencies. */}
          <Card className="report-card">
            <section aria-labelledby="portfolio-counts">
              <h2 id="portfolio-counts" className="m-0 mb-3 text-[13px] font-bold uppercase tracking-[0.4px] text-brand-muted">
                Project counts · all currencies · no money
              </h2>
              <dl className="m-0 grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-6">
                <Count label="Projects in scope" value={counts.projects} />
                <Count label="Currencies" value={counts.currencies} />
                <Count label="Source data complete" value={settled(counts.complete)} />
                <Count label="Source data incomplete" value={settled(counts.incomplete)} tone={!portfolio.loading && counts.incomplete > 0 ? 'text-brand-amber' : 'text-brand-text'} />
                <Count label="Working budget only" value={settled(counts.workingBudget)} />
                <Count label="With a financial finding" value={settled(counts.withFindings)} tone={!portfolio.loading && counts.withFindings > 0 ? 'text-brand-red' : 'text-brand-text'} />
              </dl>
              <p className="m-0 mt-3 text-[11.5px] text-brand-text-soft">
                By status:{' '}
                {counts.status.byStatus.filter(s => s.count > 0).map(s => `${s.status} ${s.count}`).join(' · ')}
                {counts.status.other > 0 ? ` · Other status ${counts.status.other}` : ''}
              </p>
              {!portfolio.loading && (
                <ul className="m-0 mt-3 grid list-none grid-cols-1 gap-x-6 gap-y-1 p-0 text-[11.5px] text-brand-text-soft md:grid-cols-2">
                  {counts.indicators.map(ind => (
                    <li key={ind.id}>
                      <span className="font-semibold text-brand-text">{ind.title}:</span>{' '}
                      <span className={ind.finding > 0 ? 'font-semibold text-brand-red' : ''}>
                        {ind.finding} {ind.finding === 1 ? 'finding' : 'findings'}
                      </span>
                      {' · '}{ind.clear} no finding
                      {' · '}
                      <span className={ind.notEvaluated > 0 ? 'text-brand-amber' : ''}>{ind.notEvaluated} not evaluated</span>
                    </li>
                  ))}
                </ul>
              )}
              <p className="m-0 mt-2 text-[11px] text-brand-muted">
                Counts of projects, not scores. “Not evaluated” means the inputs were missing, incomplete or could not
                be loaded — it is not a clear result. Programme indicators and acknowledgements are on each
                project’s PULSE tab and are not evaluated here.
              </p>
            </section>
          </Card>

          {portfolio.groups.map(group => <CurrencyGroup key={group.currencyCode} group={group} />)}

          <Card className="report-card">
            <section aria-labelledby="portfolio-definitions">
              <h2 id="portfolio-definitions" className="m-0 mb-2 text-[13px] font-bold uppercase tracking-[0.4px] text-brand-muted">
                What each figure is
              </h2>
              <dl className="m-0 grid grid-cols-1 gap-x-6 gap-y-1.5 md:grid-cols-2">
                {PORTFOLIO_FIGURES.map(spec => (
                  <div key={spec.key} className="text-[11.5px] report-figure">
                    <dt className="inline font-semibold text-brand-text">{spec.label}: </dt>
                    <dd className="m-0 inline text-brand-text-soft">{PORTFOLIO_FIGURE_NOTES[spec.key]}</dd>
                  </div>
                ))}
              </dl>
            </section>
          </Card>
        </>
      )}

      <p className="m-0 text-[11px] text-brand-muted report-footnote">
        Each project’s figures are that project’s Commercial Report figures, in its own currency. Cost, budget and
        variation figures are ex-GST; invoice balances are gross. GST is modelled as the Australian 10% rate only.
        No amount is converted, no amount is added across currencies, and nothing on this page is stored.
        Claims are not cash, invoices are not payments, forecasts are not actuals, and pending variations are not
        approved.
      </p>
    </article>
  )
}

export default function PortfolioReport() {
  const { profile, profileLoading } = useProfile()
  const { company } = useCompany()
  const { projects, projectsLoading, projectsError } = useProjects()

  if (profileLoading) {
    return <div className="text-[13px] text-brand-muted">Loading…</div>
  }
  if (!isFinancialRole(profile?.role)) {
    return (
      <Card>
        <p className="m-0 text-[13px] font-semibold text-brand-text">The Portfolio Report is restricted</p>
        <p className="m-0 mt-1 text-[12.5px] text-brand-muted">
          It is visible to Company Admin, Project Manager, and QS roles only. Access to the underlying financial
          records is enforced by Firestore Security Rules.
        </p>
      </Card>
    )
  }

  const listState = projectsListState({ loading: projectsLoading, error: projectsError, count: projects.length })
  if (listState === PROJECTS_LIST_STATE.LOADING) {
    return <div className="text-[13px] text-brand-muted" role="status">Loading projects…</div>
  }
  if (listState === PROJECTS_LIST_STATE.UNAVAILABLE) {
    return (
      <Card>
        <p className="m-0 text-[13px] font-semibold text-brand-amber">Projects unavailable</p>
        <p className="m-0 mt-1 text-[12.5px] text-brand-muted">
          Your projects could not be loaded, so no portfolio can be reported. This is not an empty portfolio — check
          your connection and access, then reload.
        </p>
      </Card>
    )
  }
  if (listState === PROJECTS_LIST_STATE.EMPTY) {
    return (
      <Card>
        <p className="m-0 text-[13px] font-semibold text-brand-text">No projects yet</p>
        <p className="m-0 mt-1 text-[12.5px] text-brand-muted">
          The Portfolio Report compares your projects once they exist.{' '}
          <Link to="/projects" className="text-brand-accent hover:underline">Go to Projects</Link>
        </p>
      </Card>
    )
  }

  return <PortfolioView projects={projects} company={company} />
}
