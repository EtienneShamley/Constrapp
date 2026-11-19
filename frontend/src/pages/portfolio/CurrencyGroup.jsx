import { Link } from 'react-router-dom'
import Card from '../../components/Card'
import Badge from '../../components/Badge'
import { formatCurrency, percent } from '../../lib/formatters'
import { currencyName } from '../../lib/currency'
import { FIGURE_STATE } from '../../lib/projectSnapshot'
import {
  PORTFOLIO_FIGURES, PORTFOLIO_FIGURE_STATE, SUBTOTAL_STATE, COMPLETENESS, RISK, RISK_LABELS,
  portfolioFigureText, portfolioSubtotalText, portfolioSubtotalNote, riskSummaryText, failedSourcesText,
} from '../../lib/portfolioReport'

// ── Portfolio · one currency group (L2-C, ADR-78) ────────────────────────────
//
// Everything in this component is in ONE currency — the group's. It renders
// lib/portfolioReport.js output and performs no arithmetic: a project figure
// is that project's Commercial Report figure, and a subtotal is the model's
// (a number only when every project in the group has a valid figure).
//
// PROJECT FIGURES and CURRENCY SUBTOTALS are kept visually apart: the subtotal
// panel sits above the projects on its own accent-edged surface, and the
// table's subtotal row is a separate, heavier footer row — each labelled with
// the currency.
//
// From `lg:` a table (scrolling inside its own container); below it, stacked
// cards. Print always uses the table.

const thCls = 'px-3 py-2.5 text-right text-brand-muted text-[11px] font-bold uppercase tracking-[0.4px] whitespace-nowrap'
const tdCls = 'px-3 py-2.5 text-right text-[12.5px] tabular-nums whitespace-nowrap align-top'

const figureTone = (figure, spec) => {
  if (figure.state === FIGURE_STATE.UNAVAILABLE) return 'text-brand-amber'
  if (figure.state === PORTFOLIO_FIGURE_STATE.NOT_APPROVED || figure.state === PORTFOLIO_FIGURE_STATE.NOT_SET) return 'text-brand-muted'
  if (figure.state === FIGURE_STATE.READY && spec.signed && typeof figure.value === 'number' && figure.value < 0) return 'text-brand-red font-semibold'
  return 'text-brand-text'
}

// One project figure: its value or its state, and — under it — why.
function Figure({ figure, spec, fmt }) {
  const working = figure.state === PORTFOLIO_FIGURE_STATE.NOT_APPROVED
  const failed = figure.state === FIGURE_STATE.UNAVAILABLE && figure.failedSources?.length > 0
  return (
    <>
      <span className={figureTone(figure, spec)}>{portfolioFigureText(figure, spec.kind, fmt, percent)}</span>
      {working && (
        <span className="block text-[10.5px] font-normal text-brand-muted">
          Working {spec.key === 'varianceToBudget' ? 'variance' : 'budget'} {fmt(figure.workingValue)}
        </span>
      )}
      {failed && (
        <span className="block max-w-[180px] whitespace-normal text-[10.5px] font-normal text-brand-amber">
          Could not load: {failedSourcesText(figure.failedSources)}
        </span>
      )}
    </>
  )
}

const RISK_TONE = {
  [RISK.FINDING]:       'text-brand-red',
  [RISK.CLEAR]:         'text-brand-text-soft',
  [RISK.NOT_EVALUATED]: 'text-brand-amber',
  [RISK.LOADING]:       'text-brand-muted',
}

const riskTone = (counts) =>
  counts[RISK.LOADING] > 0 ? RISK_TONE[RISK.LOADING]
    : counts[RISK.FINDING] > 0 ? RISK_TONE[RISK.FINDING]
      : counts[RISK.NOT_EVALUATED] > 0 ? RISK_TONE[RISK.NOT_EVALUATED]
        : RISK_TONE[RISK.CLEAR]

// The five financial indicators for one project. A native disclosure, so it is
// keyboard-operable without script. Each line states its outcome in words —
// a finding, no finding, or NOT EVALUATED (never presented as healthy).
function Indicators({ row }) {
  const { items, counts } = row.indicators
  if (counts[RISK.LOADING] > 0) return <span className="text-brand-muted">—</span>
  return (
    <details className="text-left">
      <summary className={`cursor-pointer whitespace-normal text-[12px] font-semibold ${riskTone(counts)}`}>
        {riskSummaryText(counts)}
      </summary>
      <ul className="m-0 mt-1.5 list-none space-y-1.5 p-0">
        {items.map(ind => (
          <li key={ind.id} className="whitespace-normal text-[11.5px] leading-snug text-brand-text-soft">
            <span className={`font-bold ${RISK_TONE[ind.risk]}`}>{RISK_LABELS[ind.risk]}</span>
            {' · '}{ind.title}
            <span className="block text-brand-muted">
              {ind.failedSources.length > 0
                ? `Could not load: ${failedSourcesText(ind.failedSources)}`
                : ind.headline}
              {ind.link && (
                <>
                  {' '}
                  <Link to={`/projects/${row.projectId}/${ind.link.to}`} className="text-brand-accent hover:underline report-controls">
                    {ind.link.label}
                  </Link>
                </>
              )}
            </span>
          </li>
        ))}
      </ul>
    </details>
  )
}

function Completeness({ row }) {
  if (row.completeness === COMPLETENESS.LOADING) return <span className="text-brand-muted">Loading…</span>
  if (row.completeness === COMPLETENESS.COMPLETE) return <span className="text-brand-text-soft">Complete</span>
  return (
    <span className="text-brand-amber">
      <span className="font-semibold">Incomplete</span>
      <span className="block max-w-[200px] whitespace-normal text-[10.5px]">
        Could not load: {failedSourcesText(row.failedSources)}
      </span>
    </span>
  )
}

function ProjectIdentity({ row }) {
  return (
    <>
      <Link
        to={`/projects/${row.projectId}/reports`}
        className="text-[13px] font-semibold text-brand-text hover:text-brand-accent hover:underline break-words"
      >
        {row.projectName || 'Untitled project'}
      </Link>
      <span className="mt-1 flex flex-wrap items-center gap-1.5">
        <Badge label={row.status || 'No status'} sm />
        <span className="text-[10.5px] font-semibold text-brand-muted">
          {row.currencyCode}{row.currencyInherited ? ' · inherited from company' : ''}
        </span>
      </span>
      <span className={`mt-1 block whitespace-normal text-[10.5px] font-normal ${row.budget.working ? 'text-brand-amber' : 'text-brand-muted'}`}>
        Budget: {row.budget.caption}
      </span>
    </>
  )
}

const subtotalTone = (subtotal, spec) => {
  if (subtotal.state === SUBTOTAL_STATE.INCOMPLETE) return 'text-brand-amber'
  if (subtotal.state !== SUBTOTAL_STATE.COMPLETE) return 'text-brand-muted'
  return spec.signed && subtotal.value < 0 ? 'text-brand-red' : 'text-brand-text'
}

export default function CurrencyGroup({ group }) {
  const ccy = group.currencyCode
  const fmt = (n) => formatCurrency(n, ccy, { precise: true })
  const headingId = `portfolio-${ccy}`
  const n = group.projectCount

  return (
    <Card className="report-card" padding={false}>
      <section aria-labelledby={headingId} className="report-section">
        <div className="px-4 pt-4 sm:px-5 sm:pt-5">
          <h2 id={headingId} className="m-0 text-[15px] font-bold text-brand-text">
            {ccy} <span className="font-normal text-brand-text-soft">· {currencyName(ccy)}</span>
          </h2>
          <p className="m-0 mt-0.5 text-[11.5px] text-brand-muted">
            {n} {n === 1 ? 'project' : 'projects'} in {ccy}. Every amount in this section is in {ccy}; nothing is converted.
            {group.inheritedCount > 0 && ` ${group.inheritedCount} ${group.inheritedCount === 1 ? 'project has' : 'projects have'} no currency stored and inherit the company currency.`}
          </p>
        </div>

        {/* ── Currency subtotals — NOT project figures ── */}
        <div className="mx-4 mt-4 rounded-lg border border-brand-accent/30 border-l-4 border-l-brand-accent bg-brand-card p-3.5 sm:mx-5 report-figure">
          <h3 className="m-0 text-[11px] font-bold uppercase tracking-[0.5px] text-brand-accent">
            {ccy} subtotals · {n} {n === 1 ? 'project' : 'projects'}
          </h3>
          <p className="m-0 mt-0.5 text-[11px] text-brand-muted">
            A subtotal is shown only when every project above has a valid figure. Otherwise it is not totalled.
          </p>
          <dl className="m-0 mt-3 grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2 xl:grid-cols-4">
            {PORTFOLIO_FIGURES.map(spec => {
              const s = group.subtotals[spec.key]
              return (
                <div key={spec.key} className="min-w-0">
                  <dt className="text-[10.5px] font-bold uppercase tracking-[0.4px] text-brand-muted">
                    {spec.label}{spec.pending ? ' (not approved)' : ''}
                  </dt>
                  <dd className={`m-0 mt-0.5 text-[16px] font-bold tabular-nums ${subtotalTone(s, spec)}`}>
                    {portfolioSubtotalText(s, spec.kind, fmt, percent)}
                  </dd>
                  <dd className="m-0 mt-0.5 text-[10.5px] text-brand-muted">{portfolioSubtotalNote(s)}</dd>
                </div>
              )
            })}
          </dl>
        </div>

        {/* ── lg and up (and always in print) — the comparison table ── */}
        <div className="mt-4 hidden overflow-x-auto border-t border-brand-border lg:block print:block report-table-wrap">
          <table className="w-full min-w-[1640px] border-collapse report-table print:min-w-0">
            <caption className="sr-only">
              Projects in {ccy}. One row per project, then one {ccy} subtotal row. Cost, budget and variation figures
              are ex-GST; invoice balances are gross. Variance is approved budget minus forecast final cost; negative
              means over budget.
            </caption>
            <thead>
              <tr className="bg-brand-card">
                <th scope="col" className={`${thCls} text-left pl-5`}>Project</th>
                {PORTFOLIO_FIGURES.map(spec => (
                  <th key={spec.key} scope="col" className={thCls} title={spec.label}>{spec.short}</th>
                ))}
                <th scope="col" className={`${thCls} text-left`}>Financial indicators</th>
                <th scope="col" className={`${thCls} text-left pr-5`}>Source data</th>
              </tr>
            </thead>
            <tbody>
              {group.rows.map(row => (
                <tr key={row.projectId} className="border-t border-brand-border/60">
                  <th scope="row" className={`${tdCls} min-w-[220px] whitespace-normal pl-5 text-left font-normal`}>
                    <ProjectIdentity row={row} />
                  </th>
                  {PORTFOLIO_FIGURES.map(spec => (
                    <td key={spec.key} className={tdCls}>
                      <Figure figure={row.figures[spec.key]} spec={spec} fmt={fmt} />
                    </td>
                  ))}
                  <td className={`${tdCls} min-w-[200px] text-left`}><Indicators row={row} /></td>
                  <td className={`${tdCls} pr-5 text-left`}><Completeness row={row} /></td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-brand-accent/50 bg-brand-card">
                <th scope="row" className={`${tdCls} whitespace-normal pl-5 text-left font-bold text-brand-accent`}>
                  {ccy} subtotal
                  <span className="block text-[10.5px] font-normal text-brand-muted">
                    {n} {n === 1 ? 'project' : 'projects'} · not a project
                  </span>
                </th>
                {PORTFOLIO_FIGURES.map(spec => {
                  const s = group.subtotals[spec.key]
                  return (
                    <td key={spec.key} className={`${tdCls} font-bold ${subtotalTone(s, spec)}`}>
                      {portfolioSubtotalText(s, spec.kind, fmt, percent)}
                      {s.state === SUBTOTAL_STATE.INCOMPLETE && (
                        <span className="block text-[10.5px] font-normal">{s.included} of {s.total}</span>
                      )}
                    </td>
                  )
                })}
                <td className={tdCls} />
                <td className={`${tdCls} pr-5 text-left text-brand-muted`}>
                  {group.incompleteCount > 0 ? `${group.incompleteCount} incomplete` : ''}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>

        {/* ── Below lg — one card per project ── */}
        <ul className="m-0 mt-4 list-none space-y-2.5 border-t border-brand-border p-3 sm:p-4 lg:hidden print:hidden">
          {group.rows.map(row => (
            <li key={row.projectId} className="rounded-lg border border-brand-border bg-brand-bg/40 p-3.5">
              <div className="min-w-0"><ProjectIdentity row={row} /></div>
              <dl className="m-0 mt-3 grid grid-cols-2 gap-x-3 gap-y-2.5">
                {PORTFOLIO_FIGURES.map(spec => (
                  <div key={spec.key} className="min-w-0">
                    <dt className="text-[10.5px] font-bold uppercase tracking-[0.4px] text-brand-muted">{spec.short}</dt>
                    <dd className="m-0 break-words text-[13px] font-semibold tabular-nums">
                      <Figure figure={row.figures[spec.key]} spec={spec} fmt={fmt} />
                    </dd>
                  </div>
                ))}
              </dl>
              <div className="mt-3 border-t border-brand-border/60 pt-2.5 text-[12px]">
                <p className="m-0 mb-1 text-[10.5px] font-bold uppercase tracking-[0.4px] text-brand-muted">Financial indicators</p>
                <Indicators row={row} />
              </div>
              <div className="mt-2.5 text-[12px]">
                <p className="m-0 mb-1 text-[10.5px] font-bold uppercase tracking-[0.4px] text-brand-muted">Source data</p>
                <Completeness row={row} />
              </div>
              <Link
                to={`/projects/${row.projectId}/reports`}
                className="mt-3 inline-flex min-h-[44px] items-center text-[12.5px] font-semibold text-brand-accent hover:underline"
              >
                Open Commercial Report →
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </Card>
  )
}
