import Card from '../../components/Card'
import Badge from '../../components/Badge'
import Btn from '../../components/Btn'
import ProgBar from '../../components/ProgBar'
import { formatCurrency, formatDate } from '../../lib/formatters'
import { resolveProjectCurrency } from '../../lib/currency'
import { PROJECTS_LIST_STATE } from '../../lib/projects'

// ── Dashboard · Project register (Dashboard v2, ADR-45) ──────────────────────
//
// Every project in the company, from the existing projects subscription. NO
// per-project financial column: the only amount is the HEADLINE budget — the
// creation-time metadata figure, not the live Approved Budget (ADR-39) — in
// that project's OWN currency. Progress is the manually REPORTED
// `project.progress`, not earned value or financial completion, and is labelled
// so. From `lg:` a table (scrolling inside its own container, so the Actions
// column is never clipped by the Card); below `lg:` stacked cards with 44px
// actions.

const thCls = 'text-left px-3 py-[9px] text-brand-muted text-[11px] font-bold uppercase tracking-[0.4px]'

function ProgressCell({ value }) {
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1"><ProgBar value={value ?? 0} /></div>
      <span className="w-9 text-right text-[11px] tabular-nums text-brand-muted">{value ?? 0}%</span>
    </div>
  )
}

export default function ProjectRegister({
  projects, listState, company, canViewSnapshot, selectedId, onSnapshot, onOpen, onViewAll,
}) {
  return (
    <Card padding={false}>
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-4 sm:px-5">
        <div>
          <h2 className="m-0 text-[15px] font-bold text-brand-text">Projects</h2>
          <p className="m-0 mt-0.5 text-[11.5px] text-brand-muted">
            Every project · Headline Budget in each project&apos;s own currency · progress as reported
          </p>
        </div>
        <Btn sm variant="ghost" onClick={onViewAll}>View all</Btn>
      </div>

      {listState === PROJECTS_LIST_STATE.LOADING ? (
        <div className="px-5 py-8 text-center text-[13px] text-brand-muted">Loading projects…</div>
      ) : listState === PROJECTS_LIST_STATE.UNAVAILABLE ? (
        <div className="px-5 py-8 text-center">
          <p className="m-0 text-[13px] font-semibold text-brand-amber">Projects unavailable</p>
          <p className="m-0 mt-1 text-[12px] text-brand-muted">
            Your projects could not be loaded. This is not an empty list — check your connection and access, then reload.
          </p>
        </div>
      ) : listState === PROJECTS_LIST_STATE.EMPTY ? (
        <div className="px-5 py-8 text-center text-[13px] text-brand-muted">No projects yet. Head to Projects to create one.</div>
      ) : (
        <>
          {/* lg and up — the table, in its own horizontal scroller. */}
          <div className="hidden lg:block overflow-x-auto border-t border-brand-border">
            <table className="w-full border-collapse min-w-[960px]">
              <thead>
                <tr className="bg-brand-card">
                  {['Project', 'Status', 'Headline Budget', 'Reported Progress', 'Currency', 'Start Date', 'Actions'].map(h => (
                    <th key={h} className={`${thCls} ${h === 'Project' ? 'pl-5' : ''}`}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {projects.map(p => {
                  const currencyCode = resolveProjectCurrency(p, company)
                  const isSelected = canViewSnapshot && p.id === selectedId
                  return (
                    <tr
                      key={p.id}
                      aria-current={isSelected ? 'true' : undefined}
                      className={`border-t border-brand-border transition-colors hover:bg-brand-card ${isSelected ? 'bg-brand-accent/5 shadow-[inset_3px_0_0_var(--color-brand-accent)]' : ''}`}
                    >
                      <td className="px-3 py-3 pl-5">
                        <p className="m-0 text-[13px] font-semibold leading-tight text-brand-text">{p.name}</p>
                        {p.location && <p className="m-0 mt-0.5 text-[11px] leading-tight text-brand-muted">{p.location}</p>}
                      </td>
                      <td className="px-3 py-3"><Badge label={p.status} sm /></td>
                      <td className="px-3 py-3 text-[13px] font-semibold tabular-nums text-brand-text-soft">
                        {p.budget ? formatCurrency(p.budget, currencyCode) : '—'}
                      </td>
                      <td className="min-w-[140px] px-3 py-3"><ProgressCell value={p.progress} /></td>
                      <td className="px-3 py-3 text-[12px] font-semibold text-brand-muted">{currencyCode}</td>
                      <td className="px-3 py-3 text-[12px] text-brand-muted">{formatDate(p.startDate)}</td>
                      <td className="px-3 py-3">
                        <div className="flex items-center gap-1.5">
                          {canViewSnapshot && (
                            <Btn variant="ghost" sm onClick={() => onSnapshot(p.id)}>
                              {isSelected ? 'In snapshot' : 'Snapshot'}
                            </Btn>
                          )}
                          <Btn variant="ghost" sm onClick={() => onOpen(p.id)}>Open</Btn>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          {/* Below lg — stacked cards. */}
          <ul className="lg:hidden m-0 list-none space-y-2.5 border-t border-brand-border p-3 sm:p-4">
            {projects.map(p => {
              const currencyCode = resolveProjectCurrency(p, company)
              const isSelected = canViewSnapshot && p.id === selectedId
              return (
                <li
                  key={p.id}
                  aria-current={isSelected ? 'true' : undefined}
                  className={`rounded-lg border p-3.5 ${isSelected ? 'border-brand-accent/50 bg-brand-accent/5' : 'border-brand-border bg-brand-bg/40'}`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="m-0 truncate text-[14px] font-semibold text-brand-text">{p.name}</p>
                      {p.location && <p className="m-0 mt-0.5 truncate text-[11.5px] text-brand-muted">{p.location}</p>}
                    </div>
                    <Badge label={p.status} sm />
                  </div>
                  <dl className="m-0 mt-3 grid grid-cols-2 gap-x-3 gap-y-2 text-[12px]">
                    <div className="min-w-0">
                      <dt className="text-[10.5px] font-bold uppercase tracking-[0.4px] text-brand-muted">Headline Budget</dt>
                      <dd className="m-0 truncate font-semibold tabular-nums text-brand-text-soft">
                        {p.budget ? formatCurrency(p.budget, currencyCode) : '—'}
                      </dd>
                    </div>
                    <div className="min-w-0">
                      <dt className="text-[10.5px] font-bold uppercase tracking-[0.4px] text-brand-muted">Currency · Start</dt>
                      <dd className="m-0 truncate text-brand-text-soft">{currencyCode} · {formatDate(p.startDate)}</dd>
                    </div>
                    <div className="col-span-2">
                      <dt className="text-[10.5px] font-bold uppercase tracking-[0.4px] text-brand-muted">Reported Progress</dt>
                      <dd className="m-0 mt-1"><ProgressCell value={p.progress} /></dd>
                    </div>
                  </dl>
                  <div className="mt-3 flex gap-2">
                    {canViewSnapshot && (
                      <Btn variant="ghost" onClick={() => onSnapshot(p.id)}>
                        {isSelected ? 'In snapshot' : 'Snapshot'}
                      </Btn>
                    )}
                    <Btn variant="ghost" onClick={() => onOpen(p.id)}>Open project</Btn>
                  </div>
                </li>
              )
            })}
          </ul>
        </>
      )}
    </Card>
  )
}
