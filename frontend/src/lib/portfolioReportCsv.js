import { csvRows, csvMoney, filenameSlug } from './csv'
import { FIGURE_KIND } from './commercialReport'
import { localDateKey } from './commercialReportCsv'
import {
  PORTFOLIO_FIGURES, PORTFOLIO_FIGURE_STATE, PORTFOLIO_FIGURE_NOTES, PORTFOLIO_INDICATORS,
  SUBTOTAL_STATE, COMPLETENESS, RISK,
  isPortfolioExportable, portfolioScopeText, subtotalReasonText, failedSourcesText,
} from './portfolioReport'

// ── L2-C Portfolio Report → CSV (pure) ───────────────────────────────────────
//
// Serialises ONLY the portfolio model built by lib/portfolioReport.js — never a
// raw source record. One line per project and one SUBTOTAL line per currency,
// in ONE flat table: every line carries its own Currency cell, so no amount
// can be read without its currency and a spreadsheet filter or pivot on that
// column can never mix two currencies by accident.
//
// Money is a 2-decimal number (lib/csv.js → csvMoney) in the line's currency.
// A state is always an explicit word — never a blank and never a zero:
//
//   UNAVAILABLE     a source read failed
//   NOT SET         the contract value is not established
//   NOT APPROVED    the project has a working budget only (its working amount
//                   is written in its own, separately labelled column)
//   NOT CALCULABLE  a margin on a zero or negative contract sum
//   INCOMPLETE      a currency subtotal for which not every project has a
//                   valid figure — the "Projects in subtotal" cell says how many
//
// Every text cell goes through lib/csv.js (formula-injection safe). A loading
// or empty portfolio is refused rather than written with placeholders.

export const PORTFOLIO_CSV_MARKER = {
  UNAVAILABLE:    'UNAVAILABLE',
  NOT_SET:        'NOT SET',
  NOT_APPROVED:   'NOT APPROVED',
  NOT_CALCULABLE: 'NOT CALCULABLE',
  INCOMPLETE:     'INCOMPLETE',
}

export const PORTFOLIO_CSV_ROW = { PROJECT: 'PROJECT', SUBTOTAL: 'SUBTOTAL' }

const RISK_CSV = {
  [RISK.FINDING]:       'FINDING',
  [RISK.CLEAR]:         'NO FINDING',
  [RISK.NOT_EVALUATED]: 'NOT EVALUATED',
  [RISK.LOADING]:       'NOT EVALUATED',
}

export function portfolioReportFilename(companyName, generatedAt) {
  return `constrap-portfolio-report-${filenameSlug(companyName, 'company')}-${localDateKey(generatedAt)}.csv`
}

// One project figure → one CSV value.
export function portfolioFigureCsvValue(figure, kind = FIGURE_KIND.MONEY) {
  const M = PORTFOLIO_CSV_MARKER
  if (!figure) return M.UNAVAILABLE
  if (figure.state === PORTFOLIO_FIGURE_STATE.NOT_APPROVED) return M.NOT_APPROVED
  if (figure.state === PORTFOLIO_FIGURE_STATE.NOT_SET) return M.NOT_SET
  if (figure.state !== PORTFOLIO_FIGURE_STATE.READY) return M.UNAVAILABLE
  if (figure.value === null || figure.value === undefined) {
    return kind === FIGURE_KIND.PERCENT ? M.NOT_CALCULABLE : M.UNAVAILABLE
  }
  return csvMoney(figure.value) ?? M.UNAVAILABLE
}

// One currency subtotal → one CSV value. Anything but a complete subtotal is
// a word; it can never be a number.
export function portfolioSubtotalCsvValue(subtotal) {
  const M = PORTFOLIO_CSV_MARKER
  if (!subtotal) return M.INCOMPLETE
  if (subtotal.state === SUBTOTAL_STATE.NOT_CALCULABLE) return M.NOT_CALCULABLE
  if (subtotal.state !== SUBTOTAL_STATE.COMPLETE) return M.INCOMPLETE
  return csvMoney(subtotal.value) ?? M.INCOMPLETE
}

const workingValue = (figure) =>
  figure?.state === PORTFOLIO_FIGURE_STATE.NOT_APPROVED ? (csvMoney(figure.workingValue) ?? '') : ''

const unit = (spec) => (spec.kind === FIGURE_KIND.PERCENT ? '%' : 'amount in the line currency')

export function portfolioReportCsv(portfolio, { generatedAt, companyName = '' } = {}) {
  if (!isPortfolioExportable(portfolio)) throw new Error('The portfolio is still loading or empty and cannot be exported.')
  if (!(generatedAt instanceof Date) || Number.isNaN(generatedAt.getTime())) throw new Error('A generation time is required.')

  const indicatorTitles = PORTFOLIO_INDICATORS.map(id =>
    portfolio.counts.indicators.find(i => i.id === id)?.title ?? id)

  const incomplete = portfolio.coverage !== COMPLETENESS.COMPLETE
  const rows = [
    ['Constrap Portfolio Report'],
    ['Company', companyName],
    ['Scope', portfolioScopeText(portfolio.scope)],
    ['Currencies', portfolio.currencies.join(', '),
      'Amounts are in each line\'s own currency. No amount is converted and no amount is added across currencies.'],
    ['Generated', generatedAt.toISOString(),
      'Time the export was generated. Not an accounting cut-off, period close or saved snapshot.'],
    ['Records read',
      portfolio.loadedFrom && portfolio.loadedTo ? `${portfolio.loadedFrom.toISOString()} to ${portfolio.loadedTo.toISOString()}` : '',
      'Each project was read separately within this window; the figures are not one atomic snapshot.'],
    ['Financial coverage',
      incomplete ? 'INCOMPLETE' : 'COMPLETE',
      incomplete
        ? `${portfolio.counts.incomplete} of ${portfolio.counts.projects} projects have records that could not be loaded. Their affected figures are UNAVAILABLE and the subtotals that need them are INCOMPLETE.`
        : 'Every source record of every included project was read.'],
    ['Amounts', 'Cost, budget and variation figures ex-GST; invoice balances gross (incl. GST). GST is the Australian 10% model only.'],
    [],
    ['Column', 'Unit', 'Meaning'],
    ...PORTFOLIO_FIGURES.map(spec => [spec.label, unit(spec), PORTFOLIO_FIGURE_NOTES[spec.key] ?? '']),
    [],
    [
      'Row type', 'Currency', 'Currency basis', 'Project', 'Status', 'Budget source',
      ...PORTFOLIO_FIGURES.map(spec => (spec.kind === FIGURE_KIND.PERCENT ? `${spec.label} (%)` : spec.label)),
      'Working budget (not approved)', 'Variance to working budget (not approved)',
      'Projects in subtotal', 'Subtotal notes',
      ...indicatorTitles.map(t => `Indicator: ${t}`),
      'Source completeness', 'Could not load', 'Records read at',
    ],
  ]

  for (const group of portfolio.groups) {
    for (const row of group.rows) {
      const indicatorCells = PORTFOLIO_INDICATORS.map(id => {
        const ind = row.indicators.items.find(i => i.id === id)
        return RISK_CSV[ind?.risk] ?? RISK_CSV[RISK.NOT_EVALUATED]
      })
      rows.push([
        PORTFOLIO_CSV_ROW.PROJECT,
        row.currencyCode,
        row.currencyInherited ? 'Inherited from company (no currency stored on the project)' : 'Project currency',
        row.projectName,
        row.status,
        row.budget.caption,
        ...PORTFOLIO_FIGURES.map(spec => portfolioFigureCsvValue(row.figures[spec.key], spec.kind)),
        workingValue(row.figures.approvedBudget),
        workingValue(row.figures.varianceToBudget),
        '', '',
        ...indicatorCells,
        row.completeness === COMPLETENESS.COMPLETE ? 'COMPLETE' : 'INCOMPLETE',
        failedSourcesText(row.failedSources),
        row.loadedAt instanceof Date ? row.loadedAt.toISOString() : '',
      ])
    }

    const notes = PORTFOLIO_FIGURES
      .map(spec => ({ spec, s: group.subtotals[spec.key] }))
      .filter(({ s }) => s && s.state !== SUBTOTAL_STATE.COMPLETE)
      .map(({ spec, s }) => (s.state === SUBTOTAL_STATE.NOT_CALCULABLE
        ? `${spec.label}: not calculable (contract sum subtotal is zero or negative)`
        : `${spec.label}: ${s.included} of ${s.total} projects (${subtotalReasonText(s)})`))
    rows.push([
      PORTFOLIO_CSV_ROW.SUBTOTAL,
      group.currencyCode,
      '',
      `${group.currencyCode} subtotal`,
      '', '',
      ...PORTFOLIO_FIGURES.map(spec => portfolioSubtotalCsvValue(group.subtotals[spec.key])),
      '', '',
      group.projectCount,
      notes.join('; '),
      ...PORTFOLIO_INDICATORS.map(() => ''),
      group.incompleteCount > 0 ? 'INCOMPLETE' : 'COMPLETE',
      '', '',
    ])
  }

  return csvRows(rows)
}
