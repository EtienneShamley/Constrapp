import { useMemo } from 'react'
import { ACTIVITY_STATUS, formatIsoDate, durationLabel } from '../../../lib/projectTimeline'
import { buildGanttModel, DAY_WIDTH_PX, ROW_HEIGHT_PX } from '../../../lib/timelineGantt'

// ── Read-only programme Gantt ────────────────────────────────────────────────
//
// PRESENTATION ONLY. Every offset, width, tick and marker comes from
// lib/timelineGantt.js; this component adds no arithmetic of its own and reads
// no clock — the page passes one `now` down, so the whole screen agrees on
// today (the single-clock discipline from ADR-26).
//
// ⚠️ NO CHARTING DEPENDENCY. Plain CSS boxes on a fixed day grid: a Gantt is
// positioned rectangles, and Recharts (already present for Cash Flow) has no
// range-bar primitive. Nothing was installed for this.
//
// ⚠️ READ-ONLY BY DESIGN — no dragging, no resizing, no click-to-reschedule.
// Dates are edited in the activity modal. Drag-rescheduling implies a
// rescheduling engine, which V1 deliberately does not have.
//
// ⚠️ NOT RENDERED BELOW `md:` — the page hides it; see ActivityCards.jsx.
//
// Accessibility: status is carried by the label column, the bar's `title`, and
// the textual legend — never by colour alone. Each day is a fixed-width slot
// inside ONE horizontal scroller, so a long programme scrolls rather than
// compressing into illegibility.

const LABEL_W = 220
const HEADER_H = 42

// Every colour is an existing design token, referenced as a CSS variable —
// no hex is hard-coded here and no token value was changed.
const STATUS_COLOUR = {
  [ACTIVITY_STATUS.NOT_STARTED]: 'var(--color-brand-muted)',
  [ACTIVITY_STATUS.IN_PROGRESS]: 'var(--color-brand-blue)',
  [ACTIVITY_STATUS.ON_HOLD]:     'var(--color-brand-amber)',
  [ACTIVITY_STATUS.COMPLETED]:   'var(--color-brand-accent)',
  [ACTIVITY_STATUS.CANCELLED]:   'var(--color-brand-muted)',
}

const LEGEND = [
  { label: 'Not started', colour: STATUS_COLOUR[ACTIVITY_STATUS.NOT_STARTED] },
  { label: 'In progress', colour: STATUS_COLOUR[ACTIVITY_STATUS.IN_PROGRESS] },
  { label: 'On hold',     colour: STATUS_COLOUR[ACTIVITY_STATUS.ON_HOLD] },
  { label: 'Completed',   colour: STATUS_COLOUR[ACTIVITY_STATUS.COMPLETED] },
  { label: 'Overdue',     colour: 'var(--color-brand-red)' },
]

export default function TimelineGantt({ activities, now }) {
  const model = useMemo(
    () => buildGanttModel(activities, { now, dayWidth: DAY_WIDTH_PX, rowHeight: ROW_HEIGHT_PX }),
    [activities, now],
  )

  if (model.bars.length === 0) {
    return (
      <p className="m-0 px-3.5 py-4 text-[12px] text-brand-muted">
        No activity has a usable planned start and finish, so there is nothing to draw. The table below
        remains the complete record.
      </p>
    )
  }

  const rowsHeight = model.bars.length * ROW_HEIGHT_PX

  return (
    <div>
      <div className="flex">
        {/* ── Fixed label column — the accessible row identity ─────────── */}
        <div className="shrink-0 border-r border-brand-border" style={{ width: LABEL_W }}>
          <div className="border-b border-brand-border" style={{ height: HEADER_H }} />
          {model.bars.map(bar => (
            <div
              key={bar.id}
              className="flex flex-col justify-center px-3 border-b border-brand-border/60 overflow-hidden"
              style={{ height: ROW_HEIGHT_PX }}
            >
              <span className={`text-[11.5px] font-semibold truncate ${bar.isCancelled ? 'text-brand-muted line-through' : 'text-brand-text'}`}>
                {bar.isMilestone && <span aria-hidden="true" className="mr-1">◆</span>}
                {bar.name}
              </span>
              <span className={`text-[10px] truncate ${bar.isOverdue ? 'text-brand-red font-bold' : 'text-brand-muted'}`}>
                {bar.isOverdue ? 'Overdue · ' : ''}{bar.statusLabel} · {bar.percentComplete}%
              </span>
            </div>
          ))}
        </div>

        {/* ── One shared horizontal scroller ───────────────────────────── */}
        <div className="overflow-x-auto flex-1">
          <div className="relative" style={{ width: model.canvasWidth }}>
            {/* Month header */}
            <div className="flex border-b border-brand-border" style={{ height: HEADER_H }}>
              {model.months.map(m => (
                <div
                  key={m.key}
                  className="border-r border-brand-border/60 px-2 py-1 overflow-hidden"
                  style={{ width: m.width }}
                >
                  <span className="text-[11px] font-bold text-brand-text whitespace-nowrap">{m.label}</span>
                  <span className="block text-[9.5px] text-brand-muted whitespace-nowrap">{m.days} days</span>
                </div>
              ))}
            </div>

            {/* Rows + gridlines */}
            <div className="relative" style={{ height: rowsHeight }}>
              {/* Weekly gridlines — spacing marks from the window start, not
                  working weeks (Constrapp models no working calendar). */}
              {model.weeks.map(w => (
                <div
                  key={w.iso}
                  aria-hidden="true"
                  className="absolute top-0 border-l border-brand-border/40"
                  style={{ left: w.x, height: rowsHeight }}
                />
              ))}

              {/* Today */}
              {model.todayX !== null && (
                <div
                  aria-hidden="true"
                  className="absolute top-0 border-l-2 border-brand-accent"
                  style={{ left: model.todayX, height: rowsHeight }}
                />
              )}

              {model.bars.map((bar, i) => {
                const colour = STATUS_COLOUR[bar.status] ?? STATUS_COLOUR[ACTIVITY_STATUS.NOT_STARTED]
                const title = `${bar.name} — ${bar.statusLabel}, ${bar.percentComplete}% complete. `
                  + `Planned ${formatIsoDate(bar.plannedStart)} to ${formatIsoDate(bar.plannedFinish)} (${durationLabel(bar)})`
                  + `${bar.isOverdue ? '. Overdue' : ''}`
                return (
                  <div
                    key={bar.id}
                    className="absolute left-0 right-0 border-b border-brand-border/60"
                    style={{ top: i * ROW_HEIGHT_PX, height: ROW_HEIGHT_PX }}
                  >
                    {bar.isMilestone ? (
                      <span
                        title={title}
                        aria-label={title}
                        className={`absolute rotate-45 ${bar.isOverdue ? 'border-2 border-brand-red' : ''}`}
                        style={{
                          left: bar.milestoneX - 6,
                          top: ROW_HEIGHT_PX / 2 - 6,
                          width: 12,
                          height: 12,
                          backgroundColor: bar.isCancelled ? 'var(--color-brand-muted)' : 'var(--color-brand-purple)',
                          opacity: bar.isCancelled ? 0.45 : 1,
                        }}
                      />
                    ) : (
                      <span
                        title={title}
                        aria-label={title}
                        className={`absolute rounded-md overflow-hidden ${bar.isOverdue ? 'ring-1 ring-brand-red' : ''}`}
                        style={{
                          left: bar.x,
                          top: 6,
                          width: Math.max(bar.width, 4),
                          height: ROW_HEIGHT_PX - 14,
                          backgroundColor: colour,
                          opacity: bar.isCancelled ? 0.35 : 0.45,
                          // A clipped bar is squared off at the cut edge so it
                          // does not read as starting/finishing at the border.
                          borderTopLeftRadius: bar.clippedStart ? 0 : undefined,
                          borderBottomLeftRadius: bar.clippedStart ? 0 : undefined,
                          borderTopRightRadius: bar.clippedEnd ? 0 : undefined,
                          borderBottomRightRadius: bar.clippedEnd ? 0 : undefined,
                        }}
                      >
                        {/* Progress fill — a share of the drawn bar. The figure
                            itself is always read from the table. */}
                        <span
                          className="absolute left-0 top-0 h-full"
                          style={{ width: bar.progressWidth, backgroundColor: colour }}
                        />
                      </span>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      </div>

      {/* ── Textual legend — status never depends on colour alone ─────── */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 px-3.5 py-3 border-t border-brand-border">
        {LEGEND.map(l => (
          <span key={l.label} className="inline-flex items-center gap-1.5 text-[11px] text-brand-muted">
            <span
              aria-hidden="true"
              className="inline-block w-3 h-2 rounded-sm"
              style={{ backgroundColor: l.colour }}
            />
            {l.label}
          </span>
        ))}
        <span className="inline-flex items-center gap-1.5 text-[11px] text-brand-muted">
          <span aria-hidden="true" className="text-brand-purple">◆</span> Milestone
        </span>
        <span className="inline-flex items-center gap-1.5 text-[11px] text-brand-muted">
          <span aria-hidden="true" className="inline-block w-0 h-3 border-l-2 border-brand-accent" /> Today
        </span>
        <span className="text-[11px] text-brand-muted">
          Bars show <strong className="text-brand-text-soft">planned</strong> dates; the filled portion is the entered progress %.
        </span>
      </div>

      {model.excluded.length > 0 && (
        <p className="m-0 px-3.5 pb-3 text-[11px] text-brand-amber">
          {model.excluded.length} {model.excluded.length === 1 ? 'activity is' : 'activities are'} not drawn
          (no usable planned dates, or outside the visible range) — {model.excluded.length === 1 ? 'it appears' : 'they appear'} in the table below.
        </p>
      )}

      <p className="m-0 px-3.5 pb-3.5 text-[11px] text-brand-muted">
        Read-only. Dates are changed by editing an activity — there is no drag-to-reschedule, and nothing
        moves automatically: Constrapp has no dependency links or critical path.
      </p>
    </div>
  )
}
