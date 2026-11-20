import { formatIsoDate } from '../../../lib/projectTimeline'
import { formatDayDeltaShort } from '../../../lib/ganttBaseline'
import {
  BASELINE_AVAILABILITY, BASELINE_ROW_STATE, PREDECESSOR_LEGEND, attentionSummaryItems, outsideScopeText,
} from '../../../lib/programmeReport'
import { ATTENTION_FLAG, ATTENTION_FLAG_LABELS } from '../../../lib/programmeAttention'

// ── Constrap GANTT™ Programme Report — the PRINTED programme (ADR-79) ────────
//
// A readable schedule TABLE, not the interactive chart: a Gantt wide enough
// to be useful does not fit a page, and a bar cannot be read to the day. This
// component is mounted only while the page is printing (ProjectTimeline) and
// is never shown on screen (`.programme-report` in index.css).
//
// It reuses the L2-A report print standard wholesale: the `.commercial-report`
// scope swaps the dark tokens for the ink palette, hides the app chrome and
// sets the A4-landscape page; `.report-table` repeats the header row on every
// page and keeps a row from splitting across two.
//
// PRESENTATION ONLY over lib/programmeReport.js: every cell is a model value.
// No hook, no read, no write — printing creates, approves or freezes nothing.

const stamp = (date) => date.toLocaleString('en-AU', {
  day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
})

const thCls = 'px-2 py-2 text-left text-[11px] font-bold uppercase tracking-[0.4px] text-brand-muted'
const tdCls = 'px-2 py-2 align-top text-[12px] text-brand-text'
const dateCls = `${tdCls} whitespace-nowrap tabular-nums`

// Baseline finish on the first line, the signed finish variance beneath it —
// one column, so the activity and predecessor columns keep their width.
function BaselineCell({ row }) {
  const b = row.baseline
  if (b.state === BASELINE_ROW_STATE.COMPARED) {
    return (
      <td className={dateCls}>
        {formatIsoDate(b.finish)}
        <span className={`block ${b.finishVariance > 0 ? 'font-bold text-brand-red' : ''}`}>
          {formatDayDeltaShort(b.finishVariance)}
          {b.startVariance !== 0 && <span className="font-normal text-brand-muted"> · start {formatDayDeltaShort(b.startVariance)}</span>}
        </span>
      </td>
    )
  }
  return (
    <td className={`${tdCls} programme-report-wrap`}>
      {b.finish ? formatIsoDate(b.finish) : 'Not in baseline'}
      <span className="block text-brand-muted">{b.text || 'Not compared'}</span>
    </td>
  )
}

export default function ProgrammeReport({ report, generatedAt }) {
  const b = report.baseline
  const outside = outsideScopeText(report)
  const withBaseline = b.available

  return (
    <article className="commercial-report programme-report flex-col gap-4" aria-labelledby="programme-report-title">
      <header className="report-header rounded-xl border border-brand-border p-4">
        <p className="m-0 text-[11px] font-bold uppercase tracking-[0.4px] text-brand-accent">
          Constrap · GANTT™ {report.title}
        </p>
        <h1 id="programme-report-title" className="m-0 mt-1 break-words text-xl font-semibold text-brand-text">
          {report.projectName || 'Project'}
        </h1>
        <p className="m-0 mt-1 text-[12.5px] text-brand-text-soft">
          {report.companyName && <><span className="font-bold text-brand-text">{report.companyName}</span><span aria-hidden="true"> · </span></>}
          Scope <span className="font-bold text-brand-text">{report.scope.text}</span>
        </p>
        <p className="m-0 mt-1 text-[12.5px] text-brand-text-soft">
          Baseline{' '}
          <span className="font-bold text-brand-text">
            {b.available ? b.label : (b.state === BASELINE_AVAILABILITY.NONE ? 'No approved baseline' : 'Unavailable')}
          </span>
          {b.available && b.approvedOn && <> · approved {formatIsoDate(b.approvedOn)}</>}
          <span className="block text-[11.5px] text-brand-muted">{b.text}</span>
          {b.basisText && <span className={`block text-[11.5px] ${b.isActive === false ? 'font-semibold text-brand-amber' : 'text-brand-muted'}`}>{b.basisText}</span>}
        </p>
        <p className="m-0 mt-1 text-[12px] text-brand-muted">
          Generated <time dateTime={generatedAt.toISOString()}>{stamp(generatedAt)}</time> from the current scheduling
          records at that time. Not an issued, saved or approved programme — printing creates no baseline.
        </p>
      </header>

      <section className="report-card rounded-xl border border-brand-border p-4" aria-labelledby="programme-report-attention">
        <h2 id="programme-report-attention" className="m-0 mb-2 text-[13px] font-bold uppercase tracking-[0.4px] text-brand-muted">
          Schedule attention · whole programme
        </h2>
        <dl className="m-0 grid grid-cols-6 gap-3">
          {attentionSummaryItems(report).map(item => (
            <div key={item.key} className="report-figure min-w-0">
              <dt className="text-[10.5px] font-bold uppercase tracking-[0.4px] text-brand-muted">{item.label}</dt>
              <dd className={`m-0 mt-0.5 font-black tabular-nums ${item.value === null ? 'text-[12px] text-brand-muted' : `text-[18px] ${item.value > 0 ? 'text-brand-red' : 'text-brand-text'}`}`}>
                {item.value === null ? 'Not evaluated' : item.value}
              </dd>
            </div>
          ))}
        </dl>
        <p className="m-0 mt-2 text-[11px] text-brand-muted">
          Counts of activities, each counted once per flag; one activity can carry several flags. {report.counts.conflictLinks + report.counts.reviewLinks > 0
            ? `Dependency links: ${report.counts.conflictLinks} in conflict, ${report.counts.reviewLinks} requiring review.`
            : ''}
        </p>
        {outside && <p className="m-0 mt-1.5 text-[12px] font-semibold text-brand-amber">{outside}</p>}
      </section>

      <section className="report-card rounded-xl border border-brand-border p-4" aria-labelledby="programme-report-schedule">
        <h2 id="programme-report-schedule" className="m-0 mb-2 text-[13px] font-bold uppercase tracking-[0.4px] text-brand-muted">
          Schedule · {report.inScope.activities} {report.inScope.activities === 1 ? 'activity' : 'activities'}
          {report.inScope.milestones > 0 ? ` · ${report.inScope.milestones} ${report.inScope.milestones === 1 ? 'milestone' : 'milestones'}` : ''}
        </h2>
        {report.rows.length > 0 && (
          <p className="m-0 mb-2 text-[11px] text-brand-muted">
            Dates are day/month/year. Days, days overdue and baseline variance are calendar days; a positive variance is later than
            the baseline. {PREDECESSOR_LEGEND}
          </p>
        )}
        {report.rows.length === 0 ? (
          <p className="m-0 text-[12.5px] text-brand-muted">
            {report.scope.total === 0 ? 'There are no activities in this programme.' : 'No activity matches this scope.'}
          </p>
        ) : (
          <div className="report-table-wrap">
            <table className="report-table w-full border-collapse">
              <caption className="sr-only">
                Programme schedule, {report.scope.text}. Dates are day/month/year; durations and variances are calendar days.
              </caption>
              <thead>
                <tr className="border-b border-brand-border">
                  <th scope="col" className={thCls}>Activity</th>
                  <th scope="col" className={thCls}>Planned start</th>
                  <th scope="col" className={thCls}>Planned finish</th>
                  <th scope="col" className={`${thCls} text-right`}>Days</th>
                  <th scope="col" className={thCls}>Status</th>
                  <th scope="col" className={`${thCls} text-right`}>Progress</th>
                  <th scope="col" className={thCls}>Actual start → finish</th>
                  <th scope="col" className={thCls}>Predecessors</th>
                  <th scope="col" className={thCls}>Attention</th>
                  {withBaseline && <th scope="col" className={thCls}>Baseline finish · variance</th>}
                </tr>
              </thead>
              <tbody>
                {report.rows.map(row => (
                  <tr key={row.id} className="border-b border-brand-border/60">
                    <th scope="row" className={`${tdCls} programme-report-name text-left font-semibold`}>
                      {row.isMilestone && <span aria-hidden="true">◆ </span>}
                      {row.name}
                      {row.isMilestone && <span className="ml-1 text-[10px] font-bold uppercase text-brand-purple">Milestone</span>}
                      {(row.responsibleName || row.costCodeName) && (
                        <span className="block text-[10.5px] font-normal text-brand-muted">
                          {[row.responsibleName, row.costCodeName].filter(Boolean).join(' · ')}
                        </span>
                      )}
                    </th>
                    <td className={dateCls}>{row.plannedStart ? formatIsoDate(row.plannedStart) : 'Invalid date'}</td>
                    <td className={dateCls}>{row.plannedFinish ? formatIsoDate(row.plannedFinish) : 'Invalid date'}</td>
                    <td className={`${dateCls} text-right`}>{row.durationDays === null ? '—' : row.durationDays}</td>
                    <td className={`${tdCls} whitespace-nowrap`}>{row.statusLabel}</td>
                    <td className={`${dateCls} text-right`}>{row.percentComplete === null ? '—' : `${row.percentComplete}%`}</td>
                    <td className={dateCls}>
                      {row.actualStart || row.actualFinish ? (
                        <>
                          {row.actualStart ? formatIsoDate(row.actualStart) : 'Start not recorded'}
                          <span className="block">→ {row.actualFinish ? formatIsoDate(row.actualFinish) : 'not recorded'}</span>
                        </>
                      ) : <span className="text-brand-muted">Not recorded</span>}
                    </td>
                    <td className={`${tdCls} programme-report-wrap`}>
                      {row.predecessorsShort.length === 0
                        ? <span className="text-brand-muted">None</span>
                        : row.predecessorsShort.map((p, i) => (
                          <span key={i} className={`block ${p.issue ? 'font-semibold text-brand-red' : ''}`}>{p.text}</span>
                        ))}
                    </td>
                    <td className={`${tdCls} programme-report-wrap`}>
                      {row.flagLabels.length === 0
                        ? <span className="text-brand-muted">—</span>
                        : row.flagLabels.map(l => (
                          <span key={l} className="block font-bold text-brand-red">
                            {l}{l === ATTENTION_FLAG_LABELS[ATTENTION_FLAG.OVERDUE] && row.daysLate !== null ? ` · ${row.daysLate} ${row.daysLate === 1 ? 'day' : 'days'}` : ''}
                          </span>
                        ))}
                    </td>
                    {withBaseline && <BaselineCell row={row} />}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <ul className="report-footnote m-0 list-none p-0 text-[11px] text-brand-muted">
        {report.notes.map(n => <li key={n}>{n}</li>)}
      </ul>
    </article>
  )
}
