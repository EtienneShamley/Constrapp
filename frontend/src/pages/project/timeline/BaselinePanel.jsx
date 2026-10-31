import Badge from '../../../components/Badge'
import Btn from '../../../components/Btn'
import Card from '../../../components/Card'
import { formatIsoDate } from '../../../lib/projectTimeline'
import { todayIso } from '../../../lib/payments'
import {
  ACTIVE_CHOICE, BASELINE_STATUS_LABELS, BASELINE_STATUS_BADGE, BASELINE_DESIGNATION_LABELS,
  baselineSelectorOptions, baselineVersionLabel, baselineDesignation, draftBaselines, approvedBaselines,
  formatDayDelta,
} from '../../../lib/ganttBaseline'

// ── The programme baseline panel (ADR-66) ────────────────────────────────────
//
// Everything about baselines that is not a bar: which approved version is
// selected for comparison (active by default; original or any historical
// version by choice), whether the ghost outline is shown, the drafts awaiting
// review, the capture action, and the compact variance SUMMARY — defensible
// counts only, never an average delay or a project completion claim.
//
// PRESENTATION ONLY over lib/ganttBaseline.js. Every figure is a selector
// output; the panel reads no clock, performs no arithmetic and never writes.
// The selector works at every width (the chart is desktop-only, the list and
// the cards show the same comparison), so it lives here, not in the chart
// toolbar. "You / Another user" because users/{uid} is client-read-only.

const selectCls = 'bg-brand-bg border border-brand-border rounded-lg px-3 py-2 text-[12.5px] text-brand-text focus:border-brand-accent focus:outline-none min-h-[44px]'
const toggleCls = (active) =>
  `inline-flex min-h-[44px] items-center rounded-lg border px-3 text-[12px] font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-brand-accent disabled:opacity-50 disabled:cursor-not-allowed ${
    active ? 'border-brand-accent/40 bg-brand-accent/15 text-brand-text' : 'border-brand-border text-brand-muted hover:text-brand-text hover:bg-brand-card'
  }`

const whenText = (ts) => (ts && typeof ts.toDate === 'function' ? formatIsoDate(todayIso(ts.toDate())) : 'saving…')
const whoText = (uid, currentUid) => (uid ? (uid === currentUid ? 'You' : 'Another user') : '—')

function Fact({ label, value, tone = 'text-brand-text', hint }) {
  return (
    <div className="min-w-0 rounded-lg bg-brand-bg/60 px-3 py-2">
      <p className="m-0 text-[10px] font-bold uppercase tracking-[0.4px] text-brand-muted">{label}</p>
      <p className={`m-0 mt-0.5 text-[16px] font-black tabular-nums leading-tight ${tone}`}>{value}</p>
      {hint && <p className="m-0 mt-0.5 text-[10.5px] text-brand-muted">{hint}</p>}
    </div>
  )
}

export default function BaselinePanel({
  headers, loading, error,
  snapshot, snapshotLoading, snapshotError,
  choice, onChoice, shown, onToggleShown,
  summary, selectedHeader, canWrite, currentUid,
  onCapture, onReview,
}) {
  const approved = approvedBaselines(headers)
  const drafts = draftBaselines(headers)
  const options = baselineSelectorOptions(headers)
  const selectedLabel = selectedHeader ? baselineVersionLabel(headers, selectedHeader) : ''
  const selectedDesignation = selectedHeader ? BASELINE_DESIGNATION_LABELS[baselineDesignation(headers, selectedHeader.id)] ?? '' : ''
  const summaryReady = Boolean(summary?.available)

  return (
    <Card className="mb-3.5">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="m-0 text-[13px] font-bold text-brand-text">Programme baseline</p>
          {error ? (
            <p className="m-0 mt-0.5 text-[12px] text-brand-amber">
              Baselines failed to load — they are <strong>unavailable, not absent</strong>. Nothing here compares against an approved plan.
            </p>
          ) : loading ? (
            <p className="m-0 mt-0.5 text-[12px] text-brand-muted" role="status">Loading baselines…</p>
          ) : approved.length === 0 ? (
            <p className="m-0 mt-0.5 text-[12px] text-brand-muted">
              No approved baseline. The programme is compared with nothing until one is captured and approved —
              &ldquo;overdue&rdquo; still means late against the current plan.
            </p>
          ) : (
            <p className="m-0 mt-0.5 text-[12px] text-brand-text-soft">
              <span className="font-semibold text-brand-text">{selectedLabel}</span>
              {selectedDesignation && <span className="ml-1.5 text-[10.5px] font-bold uppercase text-brand-accent">{selectedDesignation}</span>}
              {selectedHeader && (
                <span className="block text-[11.5px] text-brand-muted">
                  Approved {whenText(selectedHeader.approvedAt)} by {whoText(selectedHeader.approvedBy, currentUid)}
                  {selectedHeader.approvedBy && selectedHeader.approvedBy === selectedHeader.createdBy ? ' (captured and approved by the same person)' : ''}
                  {' · '}captured {whenText(selectedHeader.createdAt)} · {selectedHeader.activityCount} activities
                  {selectedHeader.reason ? ` · ${selectedHeader.reason}` : ''}
                </span>
              )}
              {approved.length > 1 && (
                <span className="block text-[11px] text-brand-muted">
                  {approved.length} approved versions — the original is kept; the latest approval is the active baseline.
                </span>
              )}
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2 shrink-0">
          {approved.length > 0 && (
            <>
              <label className="inline-flex items-center gap-2 text-[12px] text-brand-muted">
                Compare with
                <select
                  aria-label="Baseline version to compare with"
                  className={selectCls}
                  value={choice}
                  onChange={(e) => onChoice?.(e.target.value)}
                >
                  <option value={ACTIVE_CHOICE}>Active baseline</option>
                  {options.map(o => (
                    <option key={o.id} value={o.id}>{o.label}{o.designationLabel ? ` (${o.designationLabel})` : ''}</option>
                  ))}
                </select>
              </label>
              <button type="button" aria-pressed={shown} className={toggleCls(shown)} onClick={onToggleShown}>
                {shown ? 'Hide baseline' : 'Show baseline'}
              </button>
            </>
          )}
          {canWrite && <Btn onClick={onCapture} disabled={Boolean(error) || loading}>Capture baseline</Btn>}
        </div>
      </div>

      {/* ── Drafts awaiting review ──────────────────────────────────── */}
      {drafts.length > 0 && (
        <ul className="m-0 mt-3 p-0 list-none space-y-1.5">
          {drafts.map(d => (
            <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-brand-amber/40 bg-brand-amber/5 px-3 py-2">
              <span className="min-w-0 text-[12px] text-brand-text">
                <Badge sm label={BASELINE_STATUS_LABELS[d.status]} variant={BASELINE_STATUS_BADGE[d.status]} />
                <span className="ml-2 font-semibold">{d.name}</span>
                <span className="block text-[11px] text-brand-muted">
                  Captured {whenText(d.createdAt)} by {whoText(d.createdBy, currentUid)} · {d.activityCount} activities · not approved
                </span>
              </span>
              {canWrite
                ? <Btn sm variant="ghost" onClick={() => onReview?.(d)}>Review draft</Btn>
                : <span className="text-[11px] text-brand-muted">Awaiting approval by a company admin or project manager</span>}
            </li>
          ))}
        </ul>
      )}

      {/* ── Summary — counts only ───────────────────────────────────── */}
      {selectedHeader && snapshotError && (
        <p className="m-0 mt-3 text-[12px] text-brand-amber">
          The selected baseline&apos;s snapshot could not be read — it is <strong>unavailable</strong>, not &ldquo;no baseline&rdquo;. No comparison is shown.
        </p>
      )}
      {selectedHeader && !snapshotError && snapshotLoading && (
        <p className="m-0 mt-3 text-[12px] text-brand-muted" role="status">Loading the baseline snapshot…</p>
      )}
      {selectedHeader && !snapshotError && !snapshotLoading && snapshot && !summaryReady && (
        <p className="m-0 mt-3 text-[12px] text-brand-amber">The selected baseline&apos;s snapshot is unreadable. No comparison is shown.</p>
      )}
      {summaryReady && (
        <>
          <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-2">
            <Fact label="Captured" value={summary.captured} hint={summary.cancelledAtCapture > 0 ? `${summary.cancelledAtCapture} cancelled history` : undefined} />
            <Fact label="Added later" value={summary.addedAfter} />
            <Fact label="Cancelled since" value={summary.cancelledSince} />
            <Fact label="Earlier" value={summary.earlier} />
            <Fact label="Unchanged" value={summary.unchanged} hint={summary.startMovedOnly > 0 ? `${summary.startMovedOnly} start moved only` : undefined} />
            <Fact label="Later" value={summary.later} tone={summary.later > 0 ? 'text-brand-amber' : 'text-brand-text'} />
            <Fact label="Milestones later" value={summary.milestonesLater} tone={summary.milestonesLater > 0 ? 'text-brand-amber' : 'text-brand-text'} hint={`of ${summary.milestonesCompared} compared`} />
            <Fact label="Completed late" value={summary.completedLate} tone={summary.completedLate > 0 ? 'text-brand-amber' : 'text-brand-text'} hint={`of ${summary.completedCompared} with a recorded finish`} />
          </div>
          <p className="m-0 mt-2 text-[11.5px] text-brand-text-soft">
            {summary.largestFinish
              ? <>Largest finish movement: <strong className="text-brand-text">{summary.largestFinish.name}</strong> {formatDayDelta(summary.largestFinish.days)}.</>
              : 'No activity is planned to finish later than the baseline.'}
            {summary.envelope && (
              <> Latest planned finish: {formatIsoDate(summary.envelope.baselineFinish)} in the baseline → {formatIsoDate(summary.envelope.currentFinish)} now ({formatDayDelta(summary.envelope.days)}) — the last planned finish, <strong className="text-brand-text">not</strong> a forecast of project completion.</>
            )}
            {(summary.invalid > 0 || summary.missingSource > 0) && (
              <> {summary.invalid > 0 ? `${summary.invalid} could not be compared (unusable date). ` : ''}{summary.missingSource > 0 ? `${summary.missingSource} baseline entries have no activity in the programme.` : ''}</>
            )}
          </p>
          <p className="m-0 mt-1 text-[11px] text-brand-muted">
            Counts against {selectedLabel}, in calendar days. No average delay and no critical path — a late activity
            is not a late project. A baseline is planning evidence, not a contractual programme acceptance.
          </p>
        </>
      )}
    </Card>
  )
}
