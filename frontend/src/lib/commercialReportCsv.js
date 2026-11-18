import { csvRows, csvMoney, filenameSlug } from './csv'
import { FIGURE_STATE, MARGIN_NOT_ESTABLISHED } from './projectSnapshot'
import { FIGURE_KIND, REPORT_SOURCE_LABELS } from './commercialReport'

// ── L2-A Commercial Report → CSV (pure) ──────────────────────────────────────
//
// Serialises ONLY the report model built by lib/commercialReport.js — never a
// raw source record — so the export can contain nothing the report itself
// does not show. Money is a 2-decimal number in the project currency (named in
// the header and in every money column title); state markers are explicit
// words, never a blank or a zero:
//
//   UNAVAILABLE     a source read failed
//   NOT SET         the contract value is not established
//   NO BUDGET LINE  the cost code has no approved/working budget line
//
// A loading report is not exportable (the page disables the button), and this
// function refuses one rather than writing a placeholder.

export const CSV_MARKER = {
  UNAVAILABLE:    'UNAVAILABLE',
  NOT_SET:        'NOT SET',
  NO_BUDGET_LINE: 'NO BUDGET LINE',
}

const pad = (n) => String(n).padStart(2, '0')

// The local calendar date (YYYY-MM-DD) of a Date — the filename stamp.
export function localDateKey(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export function commercialReportFilename(report, generatedAt) {
  const slug = filenameSlug(report?.projectName, filenameSlug(report?.projectId, 'project'))
  return `constrap-commercial-report-${slug}-${localDateKey(generatedAt)}.csv`
}

// One figure → one CSV value.
export function figureCsvValue(figure, kind = FIGURE_KIND.MONEY) {
  if (!figure) return CSV_MARKER.UNAVAILABLE
  if (figure.state === MARGIN_NOT_ESTABLISHED) return CSV_MARKER.NOT_SET
  if (figure.state !== FIGURE_STATE.READY) return CSV_MARKER.UNAVAILABLE
  if (figure.value === null || figure.value === undefined) {
    // A READY margin % is null when revenue is zero or negative (lib/margin.js
    // marginPercent) — not calculable, so never a zero.
    return kind === FIGURE_KIND.PERCENT ? 'NOT CALCULABLE' : CSV_MARKER.UNAVAILABLE
  }
  return csvMoney(figure.value) ?? CSV_MARKER.UNAVAILABLE
}

const failedNote = (figure) =>
  figure?.state === FIGURE_STATE.UNAVAILABLE && figure.failedSources?.length
    ? `Could not load: ${figure.failedSources.map(s => REPORT_SOURCE_LABELS[s] ?? s).join(', ')}`
    : ''

const unitOf = (kind, currencyCode) => (kind === FIGURE_KIND.PERCENT ? '%' : currencyCode)

function figureRows(section, items, currencyCode) {
  return items.map(item => [
    section,
    item.label,
    figureCsvValue(item.figure, item.kind),
    unitOf(item.kind, currencyCode),
    [item.pending ? 'PENDING — not approved' : '', failedNote(item.figure) || item.note || ''].filter(Boolean).join('; '),
  ])
}

const rowMoney = (v) => (v === null || v === undefined ? CSV_MARKER.NO_BUDGET_LINE : (csvMoney(v) ?? CSV_MARKER.UNAVAILABLE))

export function commercialReportCsv(report, { generatedAt } = {}) {
  if (!report || report.loading) throw new Error('The report is still loading and cannot be exported.')
  if (!(generatedAt instanceof Date) || Number.isNaN(generatedAt.getTime())) throw new Error('A generation time is required.')
  const ccy = report.currencyCode

  const rows = [
    ['Constrap Commercial Report'],
    ['Project', report.projectName],
    ['Currency', ccy],
    ['Generated', generatedAt.toISOString(), 'Time the export was generated from live records. Not an accounting cut-off or period close.'],
    ['Budget source', report.budgetSourceCaption],
    ['Amounts', `${ccy}; cost and budget figures ex-GST; cash figures gross (incl. GST). GST is the Australian 10% model only.`],
    [],
    ['Section', 'Figure', 'Value', 'Unit', 'Notes'],
    ...figureRows('Summary', report.summary, ccy),
    ...figureRows('Variations', report.variations, ccy),
    ...figureRows('Cash', report.cash, ccy),
    [],
    ['Cost code breakdown'],
    [
      'Cost code',
      `Approved budget (${ccy})`, `Committed - remaining open (${ccy})`, `Claimed - awaiting certification (${ccy})`,
      `Actual cost (${ccy})`, `Forecast final cost (${ccy})`, `Cost to complete (${ccy})`, `Variance to budget (${ccy})`,
    ],
  ]

  const t = report.costCodes
  if (t.state !== FIGURE_STATE.READY) {
    rows.push([CSV_MARKER.UNAVAILABLE, failedNote(t)])
  } else if (t.rows.length === 0) {
    rows.push(['No cost codes with budget, commitment, claim, cost or forecast'])
  } else {
    for (const r of t.rows) {
      rows.push([
        r.costCodeName,
        rowMoney(r.approvedBudget),
        csvMoney(r.committed), csvMoney(r.claimed), csvMoney(r.actual),
        csvMoney(r.forecastFinalCost), csvMoney(r.costToComplete),
        rowMoney(r.varianceToBudget),
      ])
    }
    rows.push([
      'Total',
      csvMoney(t.totals.approvedBudget), csvMoney(t.totals.committed), csvMoney(t.totals.claimed),
      csvMoney(t.totals.actual), csvMoney(t.totals.forecastFinalCost), csvMoney(t.totals.costToComplete),
      csvMoney(t.totals.varianceToBudget),
    ])
  }
  return csvRows(rows)
}
