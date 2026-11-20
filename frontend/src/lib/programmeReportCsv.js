import { csvRows, filenameSlug } from './csv'
import { localDateKey } from './commercialReportCsv'
import {
  BASELINE_AVAILABILITY, BASELINE_ROW_STATE,
  isProgrammeReportExportable, attentionSummaryItems, outsideScopeText,
} from './programmeReport'

// ── Constrap GANTT™ Programme Report → CSV (pure, ADR-79) ────────────────────
//
// Serialises ONLY the model built by lib/programmeReport.js — never a raw
// activity record — so the file can contain nothing the report does not show.
//
//   · Every text cell goes through lib/csv.js (formula-injection safe, always
//     quoted). An activity name such as "=HYPERLINK(...)" is written as text.
//   · Dates are ISO 'YYYY-MM-DD' — unambiguous in every locale and sortable.
//   · Durations, progress, days overdue and day variances are NUMBERS. A
//     variance is signed: positive = later than the baseline.
//   · A value that does not exist is an explicit WORD — never a blank and
//     never a zero:
//
//       NOT RECORDED          no actual date has been recorded
//       INVALID DATE          the stored planned date is not a usable date
//       NOT ASSIGNED / NONE   no responsible contact / cost code / predecessor
//       NOT OVERDUE           the activity is not overdue
//       NO APPROVED BASELINE  no baseline comparison exists for this report
//       NOT COMPARED          a baseline is selected but this activity has no
//                             day figure against it (the comparison column
//                             says why: added after, cancelled, …)
//       NOT IN BASELINE       the activity has no captured baseline date
//       NOT EVALUATED         the later-than-baseline flag without a baseline
//
// Nothing here reads or writes Firestore. Exporting is not issuing: the file
// is a copy of current records and creates, approves or freezes no baseline.

export const PROGRAMME_CSV_MARKER = {
  NOT_RECORDED:  'NOT RECORDED',
  INVALID_DATE:  'INVALID DATE',
  NOT_ASSIGNED:  'NOT ASSIGNED',
  NONE:          'NONE',
  NOT_OVERDUE:   'NOT OVERDUE',
  NO_BASELINE:   'NO APPROVED BASELINE',
  NOT_COMPARED:  'NOT COMPARED',
  NOT_IN_BASELINE: 'NOT IN BASELINE',
  NOT_EVALUATED: 'NOT EVALUATED',
  UNAVAILABLE:   'UNAVAILABLE',
}

export const PROGRAMME_CSV_HEADINGS = [
  'Activity', 'Type',
  'Planned start', 'Planned finish', 'Duration (calendar days)',
  'Status', 'Progress (%)',
  'Actual start', 'Actual finish',
  'Responsible', 'Cost code',
  'Predecessors',
  'Overdue', 'Days overdue', 'Blocked', 'Dependency conflict', 'Dependency requires review',
  'Later than baseline',
  'Baseline start', 'Baseline finish',
  'Start variance (calendar days)', 'Finish variance (calendar days)',
  'Baseline comparison',
]

export function programmeReportFilename(report, generatedAt) {
  const slug = filenameSlug(report?.projectName, filenameSlug(report?.projectId, 'project'))
  return `constrap-programme-report-${slug}-${localDateKey(generatedAt)}.csv`
}

const M = PROGRAMME_CSV_MARKER
const yesNo = (b) => (b ? 'YES' : 'NO')
const num = (n, marker) => (typeof n === 'number' && Number.isFinite(n) ? n : marker)

function baselineCells(row, report) {
  const b = row.baseline
  if (b.state === BASELINE_ROW_STATE.NO_BASELINE) {
    const why = report.baseline.state === BASELINE_AVAILABILITY.NONE ? M.NO_BASELINE : M.UNAVAILABLE
    return [M.NOT_EVALUATED, why, why, why, why, report.baseline.text]
  }
  if (b.state === BASELINE_ROW_STATE.NOT_COMPARED) {
    return [
      yesNo(false),
      b.start ?? M.NOT_IN_BASELINE, b.finish ?? M.NOT_IN_BASELINE,
      M.NOT_COMPARED, M.NOT_COMPARED,
      b.text,
    ]
  }
  return [
    yesNo(row.flags.laterThanBaseline),
    b.start ?? M.INVALID_DATE, b.finish ?? M.INVALID_DATE,
    num(b.startVariance, M.NOT_COMPARED), num(b.finishVariance, M.NOT_COMPARED),
    b.text,
  ]
}

function activityCells(row, report) {
  return [
    row.name,
    row.typeLabel,
    row.plannedStart ?? M.INVALID_DATE,
    row.plannedFinish ?? M.INVALID_DATE,
    num(row.durationDays, M.INVALID_DATE),
    row.statusLabel,
    num(row.percentComplete, M.UNAVAILABLE),
    row.actualStart ?? M.NOT_RECORDED,
    row.actualFinish ?? M.NOT_RECORDED,
    row.responsibleName || M.NOT_ASSIGNED,
    row.costCodeName || M.NONE,
    row.predecessors.length > 0 ? row.predecessors.join('; ') : M.NONE,
    yesNo(row.flags.overdue),
    row.flags.overdue ? num(row.daysLate, M.UNAVAILABLE) : M.NOT_OVERDUE,
    yesNo(row.flags.blocked),
    yesNo(row.flags.conflict),
    yesNo(row.flags.review),
    ...baselineCells(row, report),
  ]
}

export function programmeReportCsv(report, { generatedAt } = {}) {
  if (!isProgrammeReportExportable(report)) throw new Error('The programme is still loading and cannot be exported.')
  if (!(generatedAt instanceof Date) || Number.isNaN(generatedAt.getTime())) throw new Error('A generation time is required.')

  const b = report.baseline
  const rows = [
    ['Constrap Programme Report'],
    ['Company', report.companyName || M.UNAVAILABLE],
    ['Project', report.projectName || M.UNAVAILABLE],
    ['Generated', generatedAt.toISOString(), 'Time the export was generated from current scheduling records. Not an issued, saved or approved programme; exporting creates no baseline.'],
    ['Scope', report.scope.text],
    ['Activities listed', report.inScope.activities, `of ${report.scope.total} in the programme`],
    ['Baseline', b.available ? b.label : (b.state === BASELINE_AVAILABILITY.NONE ? M.NO_BASELINE : M.UNAVAILABLE), b.text],
    ['Baseline approved', b.available && b.approvedOn ? b.approvedOn : (b.available ? M.UNAVAILABLE : (b.state === BASELINE_AVAILABILITY.NONE ? M.NO_BASELINE : M.UNAVAILABLE))],
    ['Baseline basis', b.available ? (b.isActive === true ? 'ACTIVE' : b.isActive === false ? 'HISTORICAL' : M.UNAVAILABLE) : M.NOT_EVALUATED, b.basisText || ''],
    [],
    ['Attention — whole programme', 'Activities'],
    ...attentionSummaryItems(report).map(i => [i.label, i.value === null ? M.NOT_EVALUATED : i.value]),
  ]
  const outside = outsideScopeText(report)
  if (outside) rows.push(['Note', outside])
  rows.push([])
  for (const note of report.notes) rows.push(['Note', note])
  rows.push([])
  rows.push(PROGRAMME_CSV_HEADINGS)
  if (report.rows.length === 0) {
    rows.push([report.scope.total === 0 ? 'No activities in this programme' : 'No activity matches this scope'])
  } else {
    for (const r of report.rows) rows.push(activityCells(r, report))
  }
  return csvRows(rows)
}
