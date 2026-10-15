import { PROJECTS_LIST_STATE, statusBarSegments } from '../../lib/projects'

// ── Dashboard · Portfolio summary (Dashboard v2, ADR-45) ─────────────────────
//
// Company-wide PROJECT COUNTS only — there is no money on this card, because
// projects may be in different currencies and Constrapp never converts or sums
// them (ADR-42 Decision 2). Every number comes from `portfolioSummary`
// (lib/projects.js), which returns null until the projects read has settled:
//
//   loading     → "—"            (never a false 0)
//   unavailable → "Unavailable"  (a failed read is not an empty company)
//   settled     → the real count (0 is a genuine zero)

// Fill/swatch per descriptive project status. Existing tokens only; brand-red
// stays reserved for genuine negatives. The status NAME is always printed
// beside its swatch, so nothing is communicated by colour alone.
const STATUS_FILL = {
  'Planning':    'fill-brand-blue',
  'In Progress': 'fill-brand-accent',
  'Backlogged':  'fill-brand-amber',
  'On Hold':     'fill-brand-purple',
  'Completed':   'fill-brand-text-soft',
  'Other':       'fill-brand-muted',
}
const STATUS_SWATCH = {
  'Planning':    'bg-brand-blue',
  'In Progress': 'bg-brand-accent',
  'Backlogged':  'bg-brand-amber',
  'On Hold':     'bg-brand-purple',
  'Completed':   'bg-brand-text-soft',
  'Other':       'bg-brand-muted',
}

function Count({ label, value, listState, accent = false }) {
  const unavailable = listState === PROJECTS_LIST_STATE.UNAVAILABLE
  return (
    <div className="min-w-0">
      <p className="m-0 mb-1 text-[11px] font-bold uppercase tracking-[0.5px] text-brand-muted">{label}</p>
      <p className={`m-0 font-black leading-none tabular-nums ${unavailable ? 'text-[16px] text-brand-amber' : `text-[30px] ${accent ? 'text-brand-accent' : 'text-brand-text'}`}`}>
        {unavailable ? 'Unavailable' : value === null ? '—' : value}
      </p>
    </div>
  )
}

export default function PortfolioSummary({ summary }) {
  const { listState, active, total, statusCounts } = summary
  const segments = statusBarSegments(statusCounts)

  return (
    <section
      aria-labelledby="portfolio-heading"
      className="mb-6 rounded-xl border border-brand-border bg-brand-surface p-4 sm:p-5"
    >
      <h2 id="portfolio-heading" className="m-0 mb-4 text-[11px] font-bold uppercase tracking-[0.5px] text-brand-text-soft">
        Portfolio · project counts
      </h2>
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,240px)_minmax(0,1fr)] lg:gap-8">
        <div className="grid grid-cols-2 gap-4">
          <Count label="Active projects" value={active} listState={listState} accent />
          <Count label="Total projects" value={total} listState={listState} />
        </div>

        <div className="min-w-0">
          <p className="m-0 mb-2 text-[11px] font-bold uppercase tracking-[0.5px] text-brand-muted">Projects by status</p>
          {statusCounts === null ? (
            <p className="m-0 text-[12px] text-brand-muted">
              {listState === PROJECTS_LIST_STATE.UNAVAILABLE ? 'Status breakdown unavailable — projects could not be loaded.' : '—'}
            </p>
          ) : (
            <>
              {segments.length > 0 ? (
                <svg
                  className="block h-2.5 w-full"
                  role="img"
                  aria-label={`Projects by status: ${segments.map(s => `${s.label} ${s.count}`).join(', ')}`}
                >
                  <rect x="0" y="0" width="100%" height="100%" rx="5" className="fill-brand-border" />
                  {segments.map(s => (
                    <rect key={s.status} x={`${s.offsetPct}%`} y="0" width={`${s.widthPct}%`} height="100%" className={STATUS_FILL[s.status]} />
                  ))}
                </svg>
              ) : (
                <div className="h-2.5 w-full rounded-full bg-brand-border" aria-hidden="true" />
              )}
              <ul className="m-0 mt-3 grid list-none grid-cols-2 gap-x-4 gap-y-1.5 p-0 sm:grid-cols-3 xl:grid-cols-6">
                {statusCounts.byStatus.map(({ status, count }) => (
                  <li key={status} className="flex min-w-0 items-center gap-2 text-[12px] text-brand-text-soft">
                    <span className={`inline-block h-2.5 w-2.5 shrink-0 rounded-sm ${STATUS_SWATCH[status]}`} aria-hidden="true" />
                    <span className="truncate">{status}</span>
                    <span className="ml-auto font-bold tabular-nums text-brand-text">{count}</span>
                  </li>
                ))}
                {statusCounts.other > 0 && (
                  <li className="flex min-w-0 items-center gap-2 text-[12px] text-brand-text-soft">
                    <span className={`inline-block h-2.5 w-2.5 shrink-0 rounded-sm ${STATUS_SWATCH.Other}`} aria-hidden="true" />
                    <span className="truncate">Other status</span>
                    <span className="ml-auto font-bold tabular-nums text-brand-text">{statusCounts.other}</span>
                  </li>
                )}
              </ul>
            </>
          )}
        </div>
      </div>
    </section>
  )
}
