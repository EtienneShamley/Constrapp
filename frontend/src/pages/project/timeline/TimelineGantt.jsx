import { useEffect, useMemo, useRef } from 'react'
import { ACTIVITY_STATUS, formatIsoDate, durationLabel } from '../../../lib/projectTimeline'
import {
  buildGanttModel, layoutGanttRows, todayScrollLeft, dependencyArrows, arrowPath,
  GANTT_SCALE, GANTT_SCALE_ORDER, GANTT_SCALE_LABELS,
  GANTT_ROW, ACTUAL_KIND, MAX_ARROWS_DRAWN,
  ROW_HEIGHT_PX, LABEL_WIDTH_PX, HEADER_HEIGHT_PX,
} from '../../../lib/timelineGantt'
import {
  GANTT_GROUP, GANTT_GROUP_ORDER, GANTT_GROUP_LABELS, groupGanttActivities,
} from '../../../lib/ganttGrouping'
import { stateFor, dependencyLabel, dependencyFlag, DEPENDENCY_STATE } from '../../../lib/ganttDependencies'
import { varianceFor, varianceLabel, completionLabel, baselineDatesLabel, VARIANCE_KIND } from '../../../lib/ganttBaseline'

// ── Constrapp GANTT™ — the programme chart (ADR-29 → ADR-64 → ADR-65) ────────
//
// PRESENTATION ONLY. Every offset, width, tick, row position, marker and arrow
// comes from lib/timelineGantt.js, lib/ganttGrouping.js and
// lib/ganttDependencies.js; this component adds no arithmetic of its own and
// reads no clock — the page passes one `now` down, so the whole screen agrees
// on today (the single-clock discipline, ADR-26).
//
// ⚠️ NO CHARTING DEPENDENCY. Plain CSS boxes on a fixed day grid inside ONE
// scroller that scrolls both ways: the label column is sticky to the left and
// the header is sticky to the top. Dependencies (ADR-65) are ONE SVG overlay
// behind the rows, `pointer-events: none` and `aria-hidden`, so an arrow can
// never intercept a bar; every fact an arrow carries is in the bar's
// accessible name and in the activity detail.
//
// ⚠️ ONE MODEL, THREE ZOOMS. Day / week / month change only the day width;
// grouping and collapsing change only which rows (and therefore which arrows)
// are drawn. The window, the ticks and the today line are computed once per
// filtered programme and scale.
//
// ⚠️ READ-ONLY GEOMETRY — no dragging, no resizing, no click-to-reschedule.
// Activating a bar (click, Enter or Space — it is a real <button>) opens the
// existing activity editor for an author, or the read-only detail for a
// reader; the page decides which. Nothing moves on its own.
//
// ⚠️ NOT RENDERED BELOW `md:` — the page hides it; see ActivityCards.jsx.
//
// Accessibility: each bar is a focusable button whose accessible name carries
// the activity, its status and progress, its planned and recorded dates, its
// dependencies and their state, the overdue / blocked state — never colour
// alone — and the textual legend names every colour and line style. The
// ACTIVITY TABLE remains the exact record and the accessible equivalent.

// Every colour is an existing design token, referenced as a CSS variable —
// no hex is hard-coded here and no token value was changed. The GANTT module
// token (orange) colours the heading mark and dot ONLY, never a bar.
const STATUS_COLOUR = {
  [ACTIVITY_STATUS.NOT_STARTED]: 'var(--color-brand-muted)',
  [ACTIVITY_STATUS.IN_PROGRESS]: 'var(--color-brand-blue)',
  [ACTIVITY_STATUS.ON_HOLD]:     'var(--color-brand-amber)',
  [ACTIVITY_STATUS.COMPLETED]:   'var(--color-brand-accent)',
  [ACTIVITY_STATUS.CANCELLED]:   'var(--color-brand-muted)',
}

const ACTUAL_COLOUR = 'var(--color-brand-text-soft)'

// The selected approved baseline (ADR-66): a DASHED OUTLINE behind the
// current bar (a hollow diamond for a baseline milestone), in the existing
// soft-text token — never a fill, so it can never be mistaken for a status
// bar, and never the module orange. It sits behind the bar, so it shows
// exactly where the plan has moved; the variance is always text as well.
const BASELINE_COLOUR = 'var(--color-brand-text-soft)'
const BASELINE_TOP = 3
const BASELINE_H = 18

// Dependency arrows: a well-formed link is muted; a conflict is red and
// dashed; a link needing review (cycle, cancelled, missing, malformed) is
// amber and dashed. Text always carries the meaning as well.
const ARROW_STYLE = {
  [DEPENDENCY_STATE.VALID]:     { stroke: 'var(--color-brand-muted)',  dash: '' },
  [DEPENDENCY_STATE.CONFLICT]:  { stroke: 'var(--color-brand-red)',    dash: '5 3' },
  [DEPENDENCY_STATE.CYCLE]:     { stroke: 'var(--color-brand-amber)',  dash: '3 3' },
  [DEPENDENCY_STATE.CANCELLED]: { stroke: 'var(--color-brand-amber)',  dash: '3 3' },
  [DEPENDENCY_STATE.MISSING]:   { stroke: 'var(--color-brand-amber)',  dash: '3 3' },
  [DEPENDENCY_STATE.MALFORMED]: { stroke: 'var(--color-brand-amber)',  dash: '3 3' },
}

const LEGEND = [
  { label: 'Not started', colour: STATUS_COLOUR[ACTIVITY_STATUS.NOT_STARTED] },
  { label: 'In progress', colour: STATUS_COLOUR[ACTIVITY_STATUS.IN_PROGRESS] },
  { label: 'On hold',     colour: STATUS_COLOUR[ACTIVITY_STATUS.ON_HOLD] },
  { label: 'Completed',   colour: STATUS_COLOUR[ACTIVITY_STATUS.COMPLETED] },
  { label: 'Overdue',     colour: 'var(--color-brand-red)' },
]

// A bar narrower than this is still a usable target at month zoom; the DATES
// are always read from the label, the table or the dialog, never measured.
const MIN_BAR_PX = 6
const BAR_TOP = 5
const BAR_H = 14
const ACTUAL_TOP = 23
const ACTUAL_H = 4

const toolBtnCls = (active) =>
  `inline-flex min-h-[44px] items-center rounded-lg border px-3 text-[12px] font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-brand-accent disabled:opacity-50 disabled:cursor-not-allowed ${
    active ? 'border-brand-accent/40 bg-brand-accent/15 text-brand-text' : 'border-brand-border text-brand-muted hover:text-brand-text hover:bg-brand-card'
  }`

function actualSentence(bar) {
  const a = bar.actual
  if (!a) return ''
  if (bar.isMilestone) return ` Reached ${formatIsoDate(a.to)}.`
  if (a.kind === ACTUAL_KIND.SPAN)  return ` Actual ${formatIsoDate(a.from)} to ${formatIsoDate(a.to)}.`
  if (a.kind === ACTUAL_KIND.START) return ` Actual start ${formatIsoDate(a.from)}, no finish recorded.`
  return ` Actual finish ${formatIsoDate(a.to)}, no start recorded.`
}

// The baseline sentence for the accessible name (ADR-66): the baseline
// dates, the planned variance and — only from a RECORDED finish — the
// completion variance. Empty when no baseline is shown.
function baselineSentence(bar, variance) {
  if (!variance || variance.kind === VARIANCE_KIND.NO_BASELINE) return ''
  const dates = baselineDatesLabel(variance.entry)
  const planned = varianceLabel(variance, { isMilestone: bar.isMilestone })
  const completion = completionLabel(variance, { isMilestone: bar.isMilestone })
  return `${dates ? ` ${dates}.` : ''}${planned ? ` ${planned}.` : ''}${completion ? ` ${completion}.` : ''}`
}

function barName(bar, depState, opensEditor, variance = null) {
  const planned = bar.isMilestone
    ? `Milestone ${formatIsoDate(bar.plannedStart)}`
    : `Planned ${formatIsoDate(bar.plannedStart)} to ${formatIsoDate(bar.plannedFinish)} (${durationLabel(bar)})`
  const deps = dependencyLabel(depState)
  return `${bar.name} — ${bar.statusLabel}, ${bar.percentComplete}% complete. ${planned}.`
    + actualSentence(bar)
    + (bar.planComparison ? ` ${bar.planComparison}.` : '')
    + baselineSentence(bar, variance)
    + (bar.isOverdue ? ' Overdue.' : '')
    + (deps ? ` ${deps}` : '')
    + (opensEditor ? ' Opens the editor.' : ' Opens the details.')
}

export default function TimelineGantt({
  activities, now,
  scale = GANTT_SCALE.WEEK, onScaleChange,
  groupBy = GANTT_GROUP.NONE, onGroupByChange, costCodes,
  collapsed, onToggleGroup, onCollapseAll, onExpandAll,
  onActivate, canWrite = false,
  dependencyStates,
  // ADR-66: { shown, label, byId, comparison } for the selected approved
  // baseline, or null. Presentation only — the page derives it.
  baseline = null,
}) {
  const scrollerRef = useRef(null)

  const baselineShown = Boolean(baseline?.shown && baseline.byId)
  const baselineById = baselineShown ? baseline.byId : null
  const model = useMemo(
    () => buildGanttModel(activities, { now, scale, baselineById }),
    [activities, now, scale, baselineById],
  )
  const groups = useMemo(
    () => groupGanttActivities(activities, groupBy, { costCodes, now }),
    [activities, groupBy, costCodes, now],
  )
  const ungrouped = groupBy === GANTT_GROUP.NONE
  const { rows, height } = useMemo(
    () => layoutGanttRows(model, groups, collapsed, { ungrouped }),
    [model, groups, collapsed, ungrouped],
  )
  const links = useMemo(
    () => dependencyArrows(rows, dependencyStates),
    [rows, dependencyStates],
  )

  // Centre the today line whenever the window or the zoom changes, so a zoom
  // change never leaves the user staring at an empty stretch of the canvas.
  const { todayX, canvasWidth } = model
  useEffect(() => {
    const el = scrollerRef.current
    if (!el || todayX === null) return
    const left = todayScrollLeft({ todayX, canvasWidth, viewportWidth: el.clientWidth })
    if (left !== null) el.scrollLeft = left
  }, [todayX, canvasWidth, scale])

  function scrollToToday() {
    const el = scrollerRef.current
    if (!el || todayX === null) return
    const left = todayScrollLeft({ todayX, canvasWidth, viewportWidth: el.clientWidth })
    if (left !== null) el.scrollTo({ left, behavior: 'auto' })
  }

  const totalWidth = LABEL_WIDTH_PX + model.canvasWidth
  const subTicks = model.scale === GANTT_SCALE.DAY ? model.days : model.scale === GANTT_SCALE.WEEK ? model.weeks : []
  const anyCollapsed = !ungrouped && rows.some(r => r.type === GANTT_ROW.GROUP && r.collapsed)
  const allCollapsed = !ungrouped && rows.length > 0 && rows.every(r => r.type === GANTT_ROW.GROUP && r.collapsed)

  return (
    <div>
      {/* ── Toolbar: zoom, grouping, today ─────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-2 px-3.5 py-2.5 border-b border-brand-border">
        <div role="group" aria-label="Zoom" className="flex items-center gap-1">
          {GANTT_SCALE_ORDER.map(s => (
            <button
              key={s}
              type="button"
              aria-pressed={scale === s}
              className={toolBtnCls(scale === s)}
              onClick={() => onScaleChange?.(s)}
            >
              {GANTT_SCALE_LABELS[s]}
            </button>
          ))}
        </div>
        <label className="inline-flex items-center gap-2 text-[12px] text-brand-muted">
          Group by
          <select
            aria-label="Group activities by"
            className="bg-brand-bg border border-brand-border rounded-lg px-3 py-2 text-[12.5px] text-brand-text focus:border-brand-accent focus:outline-none min-h-[44px]"
            value={groupBy}
            onChange={(e) => onGroupByChange?.(e.target.value)}
          >
            {GANTT_GROUP_ORDER.map(g => <option key={g} value={g}>{GANTT_GROUP_LABELS[g]}</option>)}
          </select>
        </label>
        {!ungrouped && (
          <>
            <button type="button" className={toolBtnCls(false)} onClick={() => onCollapseAll?.(groups)} disabled={allCollapsed}>
              Collapse all
            </button>
            <button type="button" className={toolBtnCls(false)} onClick={() => onExpandAll?.()} disabled={!anyCollapsed}>
              Expand all
            </button>
          </>
        )}
        <button
          type="button"
          className={`${toolBtnCls(false)} ml-auto`}
          onClick={scrollToToday}
          disabled={model.todayX === null}
          title={model.todayX === null ? 'Today is outside the programme window' : 'Scroll to today'}
        >
          Today
        </button>
      </div>

      {model.bars.length === 0 ? (
        <p className="m-0 px-3.5 py-4 text-[12px] text-brand-muted">
          No activity has a usable planned start and finish, so there is nothing to draw. The activity list
          remains the complete record.
        </p>
      ) : (
        /* ── ONE scroller, both axes; sticky labels and header ─────────── */
        <div ref={scrollerRef} className="overflow-auto max-h-[70vh]">
          <div className="relative" style={{ width: totalWidth, minWidth: '100%' }}>
            {/* Header */}
            <div className="sticky top-0 z-20 flex bg-brand-surface border-b border-brand-border" style={{ height: HEADER_HEIGHT_PX }}>
              <div
                className="sticky left-0 z-30 shrink-0 flex items-center px-3 bg-brand-surface border-r border-brand-border"
                style={{ width: LABEL_WIDTH_PX }}
              >
                <span className="text-[11px] font-bold text-brand-muted uppercase tracking-[0.4px]">Activity</span>
              </div>
              <div className="relative shrink-0" style={{ width: model.canvasWidth }}>
                {model.months.map(m => (
                  <div
                    key={m.key}
                    className="absolute top-0 border-r border-brand-border/60 px-1.5 overflow-hidden"
                    style={{ left: m.x, width: m.width, height: subTicks.length > 0 ? HEADER_HEIGHT_PX / 2 : HEADER_HEIGHT_PX }}
                  >
                    <span className="text-[11px] font-bold text-brand-text whitespace-nowrap leading-[21px]">{m.label}</span>
                  </div>
                ))}
                {subTicks.map(t => (
                  <div
                    key={t.iso}
                    className="absolute border-r border-brand-border/40 overflow-hidden text-center"
                    style={{ left: t.x, width: t.width, top: HEADER_HEIGHT_PX / 2, height: HEADER_HEIGHT_PX / 2 }}
                  >
                    <span className={`block text-[9.5px] whitespace-nowrap leading-[21px] ${t.iso === model.today ? 'text-brand-accent font-bold' : 'text-brand-muted'}`}>
                      {t.label}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {/* Body */}
            <div className="relative" style={{ height }}>
              {/* Gridlines, today and the dependency arrows, behind the rows.
                  Weekly lines are spacing marks from the window start, not
                  working weeks (Constrapp models no working calendar). */}
              <div aria-hidden="true" className="absolute top-0 bottom-0 pointer-events-none" style={{ left: LABEL_WIDTH_PX, width: model.canvasWidth }}>
                {model.weeks.map(w => (
                  <div key={w.iso} className="absolute top-0 bottom-0 border-l border-brand-border/40" style={{ left: w.x }} />
                ))}
                {model.todayX !== null && (
                  <div className="absolute top-0 bottom-0 border-l-2 border-brand-accent" style={{ left: model.todayX }} />
                )}
                {links.arrows.length > 0 && (
                  <svg
                    className="absolute top-0 left-0 pointer-events-none"
                    width={model.canvasWidth}
                    height={height}
                    viewBox={`0 0 ${model.canvasWidth} ${height}`}
                    aria-hidden="true"
                    focusable="false"
                  >
                    {links.arrows.map(a => {
                      const style = ARROW_STYLE[a.state] ?? ARROW_STYLE[DEPENDENCY_STATE.VALID]
                      return (
                        <g key={a.key} fill="none" stroke={style.stroke} strokeWidth="1.5" strokeDasharray={style.dash || undefined}>
                          <path d={arrowPath(a)} />
                          {/* Arrow head: a small chevron into the successor. */}
                          <path d={`M${a.toX - 5} ${a.toY - 3.5} L${a.toX} ${a.toY} L${a.toX - 5} ${a.toY + 3.5}`} strokeDasharray="0" />
                        </g>
                      )
                    })}
                  </svg>
                )}
              </div>

              {rows.map(row => (
                row.type === GANTT_ROW.GROUP ? (
                  <div key={`g:${row.key}`} className="flex" style={{ height: ROW_HEIGHT_PX }}>
                    <div
                      className="sticky left-0 z-10 shrink-0 bg-brand-surface border-r border-b border-brand-border"
                      style={{ width: LABEL_WIDTH_PX }}
                    >
                      <button
                        type="button"
                        aria-expanded={!row.collapsed}
                        onClick={() => onToggleGroup?.(row.key)}
                        className="w-full h-full flex items-center gap-1.5 px-3 text-left cursor-pointer hover:bg-brand-card focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand-accent"
                        title={row.hint || undefined}
                      >
                        <span aria-hidden="true" className="text-[10px] text-brand-muted">{row.collapsed ? '▸' : '▾'}</span>
                        <span className="min-w-0 flex-1 truncate text-[11.5px] font-bold text-brand-text">{row.label}</span>
                        <span className="shrink-0 text-[10px] text-brand-muted tabular-nums">
                          {row.count}
                          {row.overdueCount > 0 && <span className="text-brand-red font-bold"> · {row.overdueCount} overdue</span>}
                        </span>
                      </button>
                    </div>
                    <div className="shrink-0 border-b border-brand-border bg-brand-card/30" style={{ width: model.canvasWidth }} />
                  </div>
                ) : (
                  <GanttBarRow
                    key={row.key}
                    bar={row.bar}
                    depState={stateFor(dependencyStates, row.bar.id)}
                    variance={baselineShown ? varianceFor(baseline.comparison, row.bar.id) : null}
                    canvasWidth={model.canvasWidth}
                    opensEditor={canWrite && !row.bar.isCancelled}
                    onActivate={onActivate}
                  />
                )
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ── Textual legend — status never depends on colour alone ─────── */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 px-3.5 py-3 border-t border-brand-border">
        {LEGEND.map(l => (
          <span key={l.label} className="inline-flex items-center gap-1.5 text-[11px] text-brand-muted">
            <span aria-hidden="true" className="inline-block w-3 h-2 rounded-sm" style={{ backgroundColor: l.colour }} />
            {l.label}
          </span>
        ))}
        <span className="inline-flex items-center gap-1.5 text-[11px] text-brand-muted">
          <span aria-hidden="true" className="text-brand-purple">◆</span> Milestone
        </span>
        <span className="inline-flex items-center gap-1.5 text-[11px] text-brand-muted">
          <span aria-hidden="true" className="inline-block w-3 h-1 rounded-sm" style={{ backgroundColor: ACTUAL_COLOUR }} /> Actual (recorded dates)
        </span>
        <span className="inline-flex items-center gap-1.5 text-[11px] text-brand-muted">
          <span aria-hidden="true" className="inline-block w-0 h-3 border-l-2 border-brand-accent" /> Today
        </span>
        {baselineShown && (
          <>
            <span className="inline-flex items-center gap-1.5 text-[11px] text-brand-muted">
              <span aria-hidden="true" className="inline-block w-4 h-2.5 rounded-sm border border-dashed" style={{ borderColor: BASELINE_COLOUR }} />
              Baseline ({baseline.label || 'approved plan'})
            </span>
            <span className="inline-flex items-center gap-1.5 text-[11px] text-brand-muted">
              <span aria-hidden="true" className="inline-block w-2 h-2 rotate-45 border" style={{ borderColor: BASELINE_COLOUR }} /> Baseline milestone
            </span>
          </>
        )}
        <span className="inline-flex items-center gap-1.5 text-[11px] text-brand-muted">
          <span aria-hidden="true" className="inline-block w-4 h-0 border-t border-brand-muted" /> Finish-to-start dependency
        </span>
        <span className="inline-flex items-center gap-1.5 text-[11px] text-brand-muted">
          <span aria-hidden="true" className="inline-block w-4 h-0 border-t border-dashed border-brand-red" /> Dependency conflict
        </span>
        <span className="inline-flex items-center gap-1.5 text-[11px] text-brand-muted">
          <span aria-hidden="true" className="inline-block w-4 h-0 border-t border-dashed border-brand-amber" /> Dependency requires review
        </span>
        <span className="text-[11px] text-brand-muted">
          Bars show <strong className="text-brand-text-soft">planned</strong> dates; the filled portion is the entered progress %;
          the thin line beneath is what was recorded and is compared with the current plan.
          {baselineShown
            ? ' The dashed outline is the selected approved baseline; the variance against it is shown in each bar’s description and in the list.'
            : ' No approved baseline is shown, so nothing here is slippage against an approved programme.'}
        </span>
      </div>

      {(links.hidden > 0 || links.truncated) && (
        <p className="m-0 px-3.5 pb-3 text-[11px] text-brand-amber" role="status">
          {links.truncated
            ? `${links.drawable} dependencies are not drawn — more than ${MAX_ARROWS_DRAWN} would be on the chart. Every dependency is listed in each activity's details.`
            : `${links.hidden} ${links.hidden === 1 ? 'dependency is' : 'dependencies are'} not drawn because one end is filtered out, collapsed or not drawable — ${links.hidden === 1 ? 'it is' : 'they are'} still listed in each activity's details.`}
        </p>
      )}

      {model.excluded.length > 0 && (
        <p className="m-0 px-3.5 pb-3 text-[11px] text-brand-amber">
          {model.excluded.length} {model.excluded.length === 1 ? 'activity is' : 'activities are'} not drawn
          (no usable planned dates, or outside the visible range) — {model.excluded.length === 1 ? 'it appears' : 'they appear'} in the activity list.
        </p>
      )}

      <p className="m-0 px-3.5 pb-3.5 text-[11px] text-brand-muted">
        Dates are changed by opening an activity — there is no drag-to-reschedule, and nothing moves
        automatically: a dependency is shown, never enforced by moving a date, and Constrapp has no
        critical path. Calendar days; weekends and public holidays are not modelled.
      </p>
    </div>
  )
}

// One activity row: the sticky label cell and the canvas cell holding the
// planned bar (a real <button>) and, beneath it, the recorded dates (a
// decorative span — its facts are in the button's accessible name).
function GanttBarRow({ bar, depState, variance = null, canvasWidth, opensEditor, onActivate }) {
  const colour = STATUS_COLOUR[bar.status] ?? STATUS_COLOUR[ACTIVITY_STATUS.NOT_STARTED]
  const name = barName(bar, depState, opensEditor, variance)
  const actual = bar.actual
  const flag = dependencyFlag(depState)
  const ghost = bar.baseline

  return (
    <div className="flex" style={{ height: ROW_HEIGHT_PX }}>
      <div
        className="sticky left-0 z-10 shrink-0 flex flex-col justify-center px-3 bg-brand-surface border-r border-b border-brand-border/60 overflow-hidden"
        style={{ width: LABEL_WIDTH_PX }}
      >
        <span className={`text-[11.5px] font-semibold truncate ${bar.isCancelled ? 'text-brand-muted line-through' : 'text-brand-text'}`}>
          {bar.isMilestone && <span aria-hidden="true" className="mr-1">◆</span>}
          {bar.name}
          {depState.count > 0 && (
            <span className="ml-1.5 text-[10px] font-normal text-brand-muted" title={dependencyLabel(depState)}>
              ← {depState.count}
            </span>
          )}
        </span>
        <span className={`text-[10px] truncate ${bar.isOverdue || flag === 'Blocked' || flag === 'Conflict' ? 'text-brand-red font-bold' : flag === 'Review' ? 'text-brand-amber font-bold' : 'text-brand-muted'}`}>
          {bar.isOverdue ? 'Overdue · ' : ''}{flag ? `${flag} · ` : ''}{bar.statusLabel} · {bar.percentComplete}%
        </span>
      </div>

      <div className="relative shrink-0 border-b border-brand-border/60" style={{ width: canvasWidth }}>
        {/* The selected baseline's ghost — BEHIND the bar (earlier in the
            DOM), decorative: its dates and the variance are in the button's
            accessible name. A dashed outline, never a fill. */}
        {ghost && (
          ghost.isMilestone ? (
            <span
              aria-hidden="true"
              className="absolute rotate-45 border"
              style={{
                left: ghost.milestoneX - 6, top: (ROW_HEIGHT_PX - 12) / 2, width: 12, height: 12,
                borderColor: BASELINE_COLOUR,
              }}
            />
          ) : (
            <span
              aria-hidden="true"
              className="absolute rounded-md border border-dashed"
              style={{
                left: ghost.x, top: BASELINE_TOP, width: Math.max(ghost.width, MIN_BAR_PX), height: BASELINE_H,
                borderColor: BASELINE_COLOUR,
                borderTopLeftRadius: ghost.clippedStart ? 0 : undefined,
                borderBottomLeftRadius: ghost.clippedStart ? 0 : undefined,
                borderTopRightRadius: ghost.clippedEnd ? 0 : undefined,
                borderBottomRightRadius: ghost.clippedEnd ? 0 : undefined,
              }}
            />
          )
        )}
        {bar.isMilestone ? (
          <button
            type="button"
            title={name}
            aria-label={name}
            onClick={() => onActivate?.(bar.id)}
            className="absolute flex items-center justify-center cursor-pointer rounded focus-visible:outline-2 focus-visible:outline-brand-accent"
            style={{ left: bar.milestoneX - 12, top: 0, width: 24, height: ROW_HEIGHT_PX }}
          >
            <span
              aria-hidden="true"
              className={`block rotate-45 ${bar.isOverdue || depState.isBlocked ? 'border-2 border-brand-red' : ''}`}
              style={{
                width: 12,
                height: 12,
                backgroundColor: bar.isCancelled ? 'var(--color-brand-muted)' : 'var(--color-brand-purple)',
                opacity: bar.isCancelled ? 0.45 : 1,
              }}
            />
          </button>
        ) : (
          <button
            type="button"
            title={name}
            aria-label={name}
            onClick={() => onActivate?.(bar.id)}
            className={`absolute rounded-md overflow-hidden cursor-pointer focus-visible:outline-2 focus-visible:outline-brand-accent ${bar.isOverdue || depState.isBlocked ? 'ring-1 ring-brand-red' : depState.needsReview ? 'ring-1 ring-brand-amber' : ''}`}
            style={{
              left: bar.x,
              top: BAR_TOP,
              width: Math.max(bar.width, MIN_BAR_PX),
              height: BAR_H,
              backgroundColor: colour,
              opacity: bar.isCancelled ? 0.35 : 0.45,
              // A clipped bar is squared off at the cut edge so it does not
              // read as starting/finishing at the border.
              borderTopLeftRadius: bar.clippedStart ? 0 : undefined,
              borderBottomLeftRadius: bar.clippedStart ? 0 : undefined,
              borderTopRightRadius: bar.clippedEnd ? 0 : undefined,
              borderBottomRightRadius: bar.clippedEnd ? 0 : undefined,
            }}
          >
            {/* Progress fill — a share of the drawn bar. The figure itself is
                always read from the label, the list or the dialog. */}
            <span
              aria-hidden="true"
              className="absolute left-0 top-0 h-full"
              style={{ width: bar.progressWidth, backgroundColor: colour }}
            />
          </button>
        )}

        {/* Recorded dates beneath the plan — only what exists, never invented. */}
        {actual && (
          <span
            aria-hidden="true"
            className={`absolute ${actual.kind === ACTUAL_KIND.SPAN ? 'rounded-sm' : ''}`}
            style={{
              left: actual.kind === ACTUAL_KIND.SPAN ? actual.x : actual.x + actual.width / 2 - 1,
              top: ACTUAL_TOP,
              width: actual.kind === ACTUAL_KIND.SPAN ? Math.max(actual.width, 2) : 2,
              height: ACTUAL_H + (actual.kind === ACTUAL_KIND.SPAN ? 0 : 2),
              backgroundColor: ACTUAL_COLOUR,
              opacity: bar.isCancelled ? 0.35 : 0.9,
            }}
          />
        )}
      </div>
    </div>
  )
}
