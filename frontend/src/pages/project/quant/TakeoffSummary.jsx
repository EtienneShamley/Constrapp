import Card from '../../../components/Card'
import Badge from '../../../components/Badge'
import { thCls, tdCls } from './styles'
import { KIND_LABELS, formatMeasurementQuantity, quantityBreakdown } from '../../../lib/quant'
import { formatDate } from '../../../lib/formatters'
import {
  SUMMARY_ISSUE, SUMMARY_ISSUE_LABELS, SUMMARY_ISSUE_ORDER, SUMMARY_READINESS, KIND_ORDER,
} from '../../../lib/quantSummary'

// ── The project-wide takeoff summary (Quant 1C-B, ADR-53) ────────────────────
//
// PRESENTATION ONLY over lib/quantSummary.js → summariseTakeoff: every number
// here is a per-kind total of CURRENT, VALID measurements (or, separately and
// labelled, of HISTORICAL ones), already classified; nothing is summed, rounded
// or judged in this file. Lengths, areas and counts sit in their own columns
// and are never added together.
//
// A loading or failed subscription is said out loud — the summary never reads
// "no issues" while a source is pending or unavailable. Each measurement
// appears once in the attention list with every issue it carries, and once in
// the historical list; voided measurements are counted, not listed in detail.
//
// "Open" hands a target to the workspace, which validates it against the live
// register (lib/quantSummary.js → measurementTarget) and explains a measurement
// that is void, on a missing or withdrawn drawing, or otherwise unreachable.
// Desktop tables, cards below `md`, every action a real button ≥44px.

const ISSUE_BADGE = {
  [SUMMARY_ISSUE.UNREADABLE]: 'danger', [SUMMARY_ISSUE.SOURCE_MISSING]: 'danger', [SUMMARY_ISSUE.INVALID]: 'danger',
  [SUMMARY_ISSUE.UNCALIBRATED]: 'danger', [SUMMARY_ISSUE.NEEDS_REVIEW]: 'pending',
  [SUMMARY_ISSUE.LINK_MISSING]: 'pending', [SUMMARY_ISSUE.LINK_VOID]: 'pending', [SUMMARY_ISSUE.LINK_COST_CODE]: 'pending', [SUMMARY_ISSUE.LINK_UNIT]: 'pending',
  [SUMMARY_ISSUE.UNLINKED]: 'soon', [SUMMARY_ISSUE.NOT_CURRENT]: 'soon', [SUMMARY_ISSUE.DRAWING_WITHDRAWN]: 'danger',
}

const openBtnCls = 'inline-flex min-h-[44px] items-center rounded-lg px-2.5 text-[12px] font-semibold text-brand-accent hover:bg-brand-card focus-visible:outline-2 focus-visible:outline-brand-accent disabled:opacity-40'
const sectionTitleCls = 'm-0 px-4 py-3 text-[12px] font-bold uppercase tracking-[0.4px] text-brand-muted border-b border-brand-border'

// One kind total: "12.000 m²" with the contributing count, or "—". An area
// total is NET (ADR-54); when anything in it was deducted, the gross and the
// deductions are named beneath — a breakdown, never a second total.
function KindTotal({ t }) {
  if (!t || t.count === 0) return <span className="text-brand-muted">—</span>
  const deducted = typeof t.deducted === 'number' && t.deducted > 0
  return (
    <span className="tabular-nums">
      {formatMeasurementQuantity({ value: t.total, unit: t.unit })}
      <span className="ml-1 text-[11px] text-brand-muted">· {t.count}</span>
      {deducted && (
        <span className="block text-[11px] text-brand-muted">
          gross {formatMeasurementQuantity({ value: t.gross, unit: t.unit })} − deductions {formatMeasurementQuantity({ value: t.deducted, unit: t.unit })}
        </span>
      )}
    </span>
  )
}

// A row's quantity: net, with its gross − deductions line when it has holes.
function RowQuantity({ quantity }) {
  const b = quantityBreakdown(quantity)
  return (
    <>
      {formatMeasurementQuantity(quantity)}
      {b && <span className="block text-[11px] font-normal text-brand-muted">gross {b.gross} − {b.count} deduction{b.count === 1 ? '' : 's'} {b.deducted}</span>}
    </>
  )
}

function sourceLabel(row) {
  const d = row.drawing
  return `${d?.drawingNumber ?? 'Unknown drawing'} · ${row.revisionLabel ?? ''} · p.${row.m.page}`.replace(' ·  ·', ' ·')
}

function MeasurementRows({ rows, onOpenMeasurement, emptyText }) {
  if (rows.length === 0) return <p className="m-0 px-4 py-6 text-center text-[13px] text-brand-muted">{emptyText}</p>
  return (
    <>
      <div className="hidden md:block overflow-x-auto">
        <table className="w-full border-collapse min-w-[860px]">
          <thead>
            <tr className="bg-brand-card border-b border-brand-border">
              {['Label', 'Type', 'Cost code', 'Source', 'Quantity', 'Status', ''].map((h, i) => <th key={h || i} className={thCls}>{h}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map(row => (
              <tr key={row.m.id} className="border-b border-brand-border last:border-b-0">
                <td className={`${tdCls} font-semibold`}>
                  {row.m.label ?? row.m.id}
                  {row.measuredAt && <span className="block text-[11px] font-normal text-brand-muted">Measured {formatDate(row.measuredAt)}</span>}
                </td>
                <td className={`${tdCls} text-brand-muted`}>{KIND_LABELS[row.m.kind] ?? '—'}</td>
                <td className={`${tdCls} text-[12.5px]`}>{row.costCode}</td>
                <td className={`${tdCls} text-[12.5px]`}>{sourceLabel(row)}</td>
                <td className={`${tdCls} tabular-nums whitespace-nowrap`}><RowQuantity quantity={row.quantity} /></td>
                <td className={tdCls}>
                  <span className="flex flex-wrap gap-1">
                    {row.issues.map(issue => <Badge key={issue} label={SUMMARY_ISSUE_LABELS[issue]} variant={ISSUE_BADGE[issue]} sm />)}
                  </span>
                </td>
                <td className={`${tdCls} text-right`}>
                  <button type="button" className={openBtnCls} onClick={() => onOpenMeasurement(row.m)}>Open</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="md:hidden flex flex-col">
        {rows.map(row => (
          <div key={row.m.id} className="px-4 py-3 border-b border-brand-border last:border-b-0">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="m-0 text-[14px] font-bold text-brand-text break-words">{row.m.label ?? row.m.id}</p>
                <p className="m-0 mt-0.5 text-[12px] text-brand-muted">{KIND_LABELS[row.m.kind] ?? '—'} · {row.costCode}</p>
                <p className="m-0 mt-0.5 text-[12px] text-brand-muted">{sourceLabel(row)}{row.measuredAt ? ` · ${formatDate(row.measuredAt)}` : ''}</p>
              </div>
              <p className="m-0 text-right text-[15px] font-bold tabular-nums text-brand-text shrink-0"><RowQuantity quantity={row.quantity} /></p>
            </div>
            <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2">
              <span className="flex flex-wrap gap-1">
                {row.issues.map(issue => <Badge key={issue} label={SUMMARY_ISSUE_LABELS[issue]} variant={ISSUE_BADGE[issue]} sm />)}
              </span>
              <button type="button" className={openBtnCls} onClick={() => onOpenMeasurement(row.m)}>Open</button>
            </div>
          </div>
        ))}
      </div>
    </>
  )
}

export default function TakeoffSummary({ summary, readiness, onOpenMeasurement, onOpenPage }) {
  const loading = readiness === SUMMARY_READINESS.LOADING
  const unavailable = readiness === SUMMARY_READINESS.UNAVAILABLE
  const ready = readiness === SUMMARY_READINESS.READY
  const { counts, totals, issueCounts, byCostCode, byDrawing, attention, historical, voided } = summary

  return (
    <div className="flex flex-col gap-3.5">
      <Card>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h2 className="m-0 text-[15px] font-bold text-brand-text">Project takeoff summary</h2>
            <p className="m-0 mt-0.5 text-[12px] text-brand-muted">
              Every active measurement in this project, read live. Totals are per kind and never mix metres, square
              metres and counts; only current, valid measurements reach a total — historical sheets are totalled apart.
            </p>
          </div>
          {ready && (
            <div className="flex flex-wrap gap-1.5 shrink-0" aria-label="Measurement counts">
              <Badge label={`Current & valid · ${counts.current}`} variant="active" sm />
              <Badge label={`Needs attention · ${counts.attention}`} variant={counts.attention > 0 ? 'pending' : 'soon'} sm />
              <Badge label={`Historical · ${counts.historical}`} variant="soon" sm />
              <Badge label={`Voided · ${counts.void}`} variant="soon" sm />
            </div>
          )}
        </div>

        {loading && <p role="status" className="m-0 mt-3 text-[12.5px] text-brand-muted">Loading the measurements, sheets, drawings, cost codes and BOQ items…</p>}
        {unavailable && (
          <p role="alert" className="m-0 mt-3 rounded-lg border-2 border-brand-red bg-brand-red/10 px-3 py-2 text-[12.5px] font-semibold text-brand-red">
            A required source failed to load. The summary cannot be shown — this is not &quot;no measurements&quot; and not &quot;no issues&quot;.
          </p>
        )}

        {ready && (
          <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
            <div className="rounded-lg bg-brand-bg/60 px-3 py-2">
              <p className="m-0 text-[10.5px] font-bold uppercase tracking-[0.4px] text-brand-muted">Current &amp; valid — project totals</p>
              <dl className="m-0 mt-1 grid grid-cols-3 gap-2">
                {KIND_ORDER.map(kind => (
                  <div key={kind}>
                    <dt className="m-0 text-[11px] text-brand-muted">{KIND_LABELS[kind]}</dt>
                    <dd className="m-0 text-[13px] font-semibold text-brand-text"><KindTotal t={totals.current[kind]} /></dd>
                  </div>
                ))}
              </dl>
            </div>
            <div className="rounded-lg bg-brand-bg/60 px-3 py-2">
              <p className="m-0 text-[10.5px] font-bold uppercase tracking-[0.4px] text-brand-muted">Historical — earlier revisions, kept apart</p>
              <dl className="m-0 mt-1 grid grid-cols-3 gap-2">
                {KIND_ORDER.map(kind => (
                  <div key={kind}>
                    <dt className="m-0 text-[11px] text-brand-muted">{KIND_LABELS[kind]}</dt>
                    <dd className="m-0 text-[13px] font-semibold text-brand-text"><KindTotal t={totals.historical[kind]} /></dd>
                  </div>
                ))}
              </dl>
            </div>
          </div>
        )}
        {ready && counts.attention + counts.current + counts.historical === 0 && (
          <p className="m-0 mt-3 text-[12.5px] text-brand-muted">No active measurements in this project yet. Switch to Measure, choose a drawing and start.</p>
        )}
      </Card>

      {ready && (
        <>
          <Card padding={false}>
            <h3 className={sectionTitleCls}>By cost code · current &amp; valid</h3>
            {byCostCode.length === 0 ? (
              <p className="m-0 px-4 py-6 text-center text-[13px] text-brand-muted">Nothing measured yet.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full border-collapse min-w-[640px]">
                  <thead>
                    <tr className="bg-brand-card border-b border-brand-border">
                      {['Cost code', 'Length', 'Area', 'Count', 'Attention', 'Historical'].map(h => <th key={h} className={thCls}>{h}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {byCostCode.map(g => (
                      <tr key={g.costCodeId} className="border-b border-brand-border last:border-b-0">
                        <td className={`${tdCls} font-semibold`}>{g.name}</td>
                        {KIND_ORDER.map(kind => <td key={kind} className={tdCls}><KindTotal t={g.totals[kind]} /></td>)}
                        <td className={tdCls}>{g.counts.attention > 0 ? <Badge label={String(g.counts.attention)} variant="pending" sm /> : <span className="text-brand-muted">—</span>}</td>
                        <td className={`${tdCls} text-brand-muted`}>{g.counts.historical > 0 ? g.counts.historical : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <Card padding={false}>
            <h3 className={sectionTitleCls}>By drawing · revision · page</h3>
            {byDrawing.length === 0 ? (
              <p className="m-0 px-4 py-6 text-center text-[13px] text-brand-muted">Nothing measured yet.</p>
            ) : byDrawing.map(dg => (
              <div key={dg.drawingId} className="border-b border-brand-border last:border-b-0">
                <p className="m-0 px-4 pt-3 pb-1 text-[13px] font-bold text-brand-text">
                  {dg.number}{dg.title ? ` — ${dg.title}` : ''}
                  {dg.withdrawn && <Badge label="Drawing withdrawn" variant="danger" sm />}
                  {!dg.drawing && <Badge label="Not in register" variant="danger" sm />}
                </p>
                {dg.revisions.map(rg => (
                  <div key={rg.revisionId} className="px-4 pb-2">
                    <p className="m-0 py-1 text-[12px] font-semibold text-brand-muted">{rg.label}</p>
                    <div className="overflow-x-auto">
                      <table className="w-full border-collapse min-w-[640px]">
                        <tbody>
                          {rg.pages.map(pg => (
                            <tr key={pg.pageId} className="border-t border-brand-border">
                              <td className={`${tdCls} w-[80px] font-semibold`}>p.{pg.page}</td>
                              {KIND_ORDER.map(kind => (
                                <td key={kind} className={tdCls}>
                                  <span className="block text-[10.5px] uppercase tracking-[0.4px] text-brand-muted">{KIND_LABELS[kind]}</span>
                                  <KindTotal t={rg.current ? pg.totals[kind] : pg.historical[kind]} />
                                </td>
                              ))}
                              <td className={`${tdCls} text-[12px] text-brand-muted whitespace-nowrap`}>
                                {pg.counts.attention > 0 && <Badge label={`${pg.counts.attention} attention`} variant="pending" sm />}
                                {pg.counts.void > 0 && <span className="ml-1">{pg.counts.void} voided</span>}
                              </td>
                              <td className={`${tdCls} text-right`}>
                                {pg.target && <button type="button" className={openBtnCls} onClick={() => onOpenPage(pg.target)}>Open sheet</button>}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                ))}
              </div>
            ))}
          </Card>

          <Card padding={false}>
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-brand-border px-4 py-3">
              <h3 className="m-0 text-[12px] font-bold uppercase tracking-[0.4px] text-brand-muted">Needs attention · {attention.length}</h3>
              <span className="flex flex-wrap gap-1">
                {SUMMARY_ISSUE_ORDER.filter(issue => issueCounts[issue]).map(issue => (
                  <Badge key={issue} label={`${SUMMARY_ISSUE_LABELS[issue]} · ${issueCounts[issue]}`} variant={ISSUE_BADGE[issue]} sm />
                ))}
              </span>
            </div>
            <MeasurementRows rows={attention} onOpenMeasurement={onOpenMeasurement} emptyText="Nothing needs attention: every current measurement is calibrated, reviewed, derivable and linked." />
          </Card>

          <Card padding={false}>
            <details className="group">
              <summary className="flex min-h-[44px] cursor-pointer list-none items-center gap-2 px-4 text-[12px] font-bold uppercase tracking-[0.4px] text-brand-muted">
                <span className="transition-transform group-open:rotate-90">▸</span>
                Historical · {historical.length}
                <span className="font-normal normal-case tracking-normal">— earlier revisions and withdrawn drawings; never summed with current work</span>
              </summary>
              <div className="border-t border-brand-border">
                <MeasurementRows rows={historical} onOpenMeasurement={onOpenMeasurement} emptyText="No measurements on earlier revisions." />
              </div>
            </details>
          </Card>

          <Card padding={false}>
            <details className="group">
              <summary className="flex min-h-[44px] cursor-pointer list-none items-center gap-2 px-4 text-[12px] font-bold uppercase tracking-[0.4px] text-brand-muted">
                <span className="transition-transform group-open:rotate-90">▸</span>
                Voided · {voided.length}
              </summary>
              <ul className="m-0 list-none border-t border-brand-border p-0">
                {voided.length === 0 && <li className="px-4 py-3 text-[12.5px] text-brand-muted">No voided measurements.</li>}
                {voided.map(row => (
                  <li key={row.m.id} className="px-4 py-2 text-[12.5px] text-brand-muted border-b border-brand-border last:border-b-0">
                    <span className="line-through">{row.m.label ?? row.m.id}</span> · {KIND_LABELS[row.m.kind] ?? '—'} · {row.costCode} · {sourceLabel(row)}
                    {row.m.voidReason && <span className="block text-[11.5px]">Reason: {row.m.voidReason}</span>}
                  </li>
                ))}
              </ul>
            </details>
          </Card>
        </>
      )}
    </div>
  )
}
