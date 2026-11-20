import {
  ACTIVITY_STATUS_LABELS, DUE_FILTER, DUE_FILTER_OPTIONS,
  isValidIsoDate, activityDuration,
} from './projectTimeline'
import { DEPENDENCY_STATE, stateFor } from './ganttDependencies'
import {
  VARIANCE_KIND, activeBaseline, baselineVersionLabel, varianceFor, varianceLabel, completionLabel,
} from './ganttBaseline'
import { approvedOnIso, baselineSnapshotProblem, BASELINE_PROBLEM_TEXT } from './pulseSchedule'
import {
  ATTENTION_FLAG_ORDER, ATTENTION_FLAG_LABELS,
  attentionFor, attentionFilterLabel, attentionOutsideScope,
} from './programmeAttention'

// ── Constrap GANTT™ — the Programme Report model (ADR-79) ────────────────────
//
// PURE. No Firestore, no React, no clock. Builds the ONE model that the
// printed programme report and the CSV both serialise, so the two can never
// disagree and neither can contain something the page does not show.
//
// ⚠️ IT COMPOSES; IT CALCULATES NOTHING NEW. Dates and durations are
// lib/projectTimeline.js, link states are lib/ganttDependencies.js, variance
// is lib/ganttBaseline.js and the attention flags are lib/programmeAttention.js
// (which is the PULSE row builders). There is no critical path, no forecast
// completion and no financial figure here.
//
// ⚠️ A REPORT IS A REPRESENTATION OF CURRENT SCHEDULING RECORDS. Building,
// printing or exporting it writes nothing: it does not create, approve,
// freeze or issue a baseline, and it is not a saved or issued programme.
//
// SCOPE. `rows` are the activities the page is DISPLAYING (after every
// filter); the attention counts and the dependency states are always the
// WHOLE programme's. The model states the scope in words and says how many
// flagged activities the scope leaves out — a filtered report never silently
// drops a warning.

// ── Baseline availability ────────────────────────────────────────────────────

export const BASELINE_AVAILABILITY = {
  AVAILABLE:   'available',
  LOADING:     'loading',      // headers or the selected snapshot still loading
  NONE:        'none',         // no approved baseline exists
  UNAVAILABLE: 'unavailable',  // a read failed
  UNUSABLE:    'unusable',     // the snapshot is missing or not a usable capture
}

export const BASELINE_AVAILABILITY_TEXT = {
  [BASELINE_AVAILABILITY.LOADING]:
    'The baseline is still loading.',
  [BASELINE_AVAILABILITY.NONE]:
    'No approved baseline exists for this programme, so there is no baseline comparison. Nothing in this report is slippage against an approved programme.',
  [BASELINE_AVAILABILITY.UNAVAILABLE]:
    'The approved baseline could not be loaded, so the baseline comparison is unavailable — not zero and not "unchanged".',
  [BASELINE_AVAILABILITY.UNUSABLE]:
    'The selected approved baseline has no usable snapshot, so the baseline comparison is unavailable — not zero and not "unchanged".',
}

// The SELECTED approved baseline as the page holds it, reduced to one state.
// `header` is lib/ganttBaseline.js → selectedBaseline(...) and `snapshot` the
// one document the page subscribes to for it.
//
// ⚠️ INTEGRITY IS PULSE'S, NOT A SECOND RULE. A settled header + snapshot pair
// is fit to compare only when lib/pulseSchedule.js → baselineSnapshotProblem
// says so — the same check PULSE applies to the active baseline: the snapshot
// exists, is this version's, is a usable capture, and agrees with its header
// on the number of activities captured. Anything else is UNUSABLE: no
// variance, no flag, no count — never a figure from a baseline that may be
// incomplete.
//
// ⚠️ SELECTED IS NOT ALWAYS ACTIVE. PULSE always measures against the ACTIVE
// (latest approved) baseline; this page may be showing a historical version.
// `headers` (the page's header list) lets the result say which it is —
// `isActive` true / false, or null when the list was not supplied — and
// `basisText` states the difference in words for the interface and exports.
export function baselineAvailability({
  headers = null, headersLoading = false, headersError = false, header = null, label = '',
  snapshot = null, snapshotLoading = false, snapshotError = false,
} = {}) {
  const active = headers ? activeBaseline(headers) : null
  const isActive = header && headers ? Boolean(active) && active.id === header.id : null
  const activeLabel = active ? baselineVersionLabel(headers, active) : ''
  const base = {
    header, label: header ? label : '', approvedOn: header ? approvedOnIso(header) : null,
    isActive, activeLabel, problem: null,
  }
  let state
  let problem = null
  if (headersLoading) state = BASELINE_AVAILABILITY.LOADING
  else if (headersError) state = BASELINE_AVAILABILITY.UNAVAILABLE
  else if (!header) state = BASELINE_AVAILABILITY.NONE
  else if (snapshotLoading) state = BASELINE_AVAILABILITY.LOADING
  else if (snapshotError) state = BASELINE_AVAILABILITY.UNAVAILABLE
  else {
    problem = baselineSnapshotProblem(header, snapshot)
    state = problem ? BASELINE_AVAILABILITY.UNUSABLE : BASELINE_AVAILABILITY.AVAILABLE
  }
  const available = state === BASELINE_AVAILABILITY.AVAILABLE
  const named = base.label || 'the selected approved baseline'
  let text
  if (available) text = `Compared with ${named} — planning evidence, not a contractual programme acceptance.`
  else if (problem) text = `${base.label || 'The selected approved baseline'} cannot be compared: ${BASELINE_PROBLEM_TEXT[problem]}. The baseline comparison is unavailable — not zero and not "unchanged".`
  else text = BASELINE_AVAILABILITY_TEXT[state]
  // Which version this is relative to the one PULSE uses. Said only for a
  // baseline that IS being compared, and only when the header list is known.
  let basisText = ''
  if (available && isActive === true) {
    basisText = 'This is the active approved baseline — the version Constrap PULSE™ measures against.'
  } else if (available && isActive === false) {
    basisText = `This is a historical approved baseline, not the active one (${activeLabel}). Constrap PULSE™ measures against the active baseline, so its later-than-baseline count can differ from the one here.`
  }
  return { ...base, state, available, problem, text, basisText }
}

// ── Scope ────────────────────────────────────────────────────────────────────

const dueLabelFor = (due) => DUE_FILTER_OPTIONS.find(o => o.value === due)?.label ?? ''

// The filters in force, in words. `responsibleName` is the picker's label for
// the chosen contact; nothing is looked up here.
export function programmeScope({
  search = '', status = '', responsibleName = '', hideClosed = false,
  due = DUE_FILTER.ANY, attention = '', shown = 0, total = 0,
} = {}) {
  const parts = []
  if (attention) parts.push(`Attention: ${attentionFilterLabel(attention)}`)
  if (status) parts.push(`Status: ${ACTIVITY_STATUS_LABELS[status] ?? status}`)
  if (responsibleName) parts.push(`Responsible: ${responsibleName}`)
  if (due) parts.push(`Due: ${dueLabelFor(due)}`)
  if (hideClosed) parts.push('Completed and cancelled hidden')
  if (String(search).trim()) parts.push(`Search: “${String(search).trim()}”`)
  const filtered = parts.length > 0
  const count = `${shown} of ${total} ${total === 1 ? 'activity' : 'activities'}`
  return {
    filtered,
    parts,
    shown,
    total,
    text: filtered ? `Filtered programme — ${count} (${parts.join('; ')})` : `Whole programme — ${count}`,
  }
}

// ── Rows ─────────────────────────────────────────────────────────────────────

const iso = (v) => (isValidIsoDate(v) ? v : null)

const lagText = (lag) => (lag > 0 ? ` +${lag} ${lag === 1 ? 'day' : 'days'}` : '')

// One predecessor link, in words — the link's own state is always written,
// so a conflict or a link needing review is on the report even when the
// predecessor itself is filtered out of it.
export function predecessorText(entry) {
  const who = entry?.name || entry?.activityId || 'Malformed entry'
  if (entry?.state === DEPENDENCY_STATE.VALID) {
    return `${who} (finish to start${lagText(entry.lagDays)}${entry.finished ? ', finished' : ''})`
  }
  return `${who} (finish to start${lagText(entry?.lagDays ?? 0)} — ${entry?.stateLabel ?? 'requires review'})`
}

// The same link, compact, for the printed table (the legend on the report
// spells out "FS"). The state is still always written.
const SHORT_STATE = {
  [DEPENDENCY_STATE.CONFLICT]:  'conflict',
  [DEPENDENCY_STATE.MISSING]:   'missing — review',
  [DEPENDENCY_STATE.CANCELLED]: 'cancelled — review',
  [DEPENDENCY_STATE.MALFORMED]: 'malformed — review',
  [DEPENDENCY_STATE.CYCLE]:     'cycle — review',
}

export function predecessorShort(entry) {
  const who = entry?.name || entry?.activityId || 'Malformed entry'
  const lag = entry?.lagDays > 0 ? ` +${entry.lagDays}d` : ''
  const valid = entry?.state === DEPENDENCY_STATE.VALID
  const state = valid ? (entry.finished ? 'finished' : '') : (SHORT_STATE[entry?.state] ?? 'review')
  return { text: `${who} · FS${lag}${state ? ` · ${state}` : ''}`, issue: !valid }
}

export const PREDECESSOR_LEGEND = 'FS = finish to start; +n d = lag in calendar days.'

// Why a row has no variance figure, when it has none.
export const BASELINE_ROW_STATE = {
  COMPARED:     'compared',
  NOT_COMPARED: 'not_compared',   // in scope of a baseline, but no day figure (added, cancelled, invalid)
  NO_BASELINE:  'no_baseline',    // no usable selected baseline at all
}

function baselineCell(activity, baseline, comparison) {
  if (!baseline?.available) {
    return {
      state: BASELINE_ROW_STATE.NO_BASELINE, kind: VARIANCE_KIND.NO_BASELINE,
      start: null, finish: null, startVariance: null, finishVariance: null, text: '',
    }
  }
  const v = varianceFor(comparison, activity.id)
  const opts = { isMilestone: activity.isMilestone === true }
  const text = [varianceLabel(v, opts), completionLabel(v, opts)].filter(Boolean).join('. ')
  if (v.kind !== VARIANCE_KIND.IN_BASELINE) {
    return {
      state: BASELINE_ROW_STATE.NOT_COMPARED, kind: v.kind,
      start: iso(v.entry?.plannedStart), finish: iso(v.entry?.plannedFinish),
      startVariance: null, finishVariance: null, text,
    }
  }
  return {
    state: BASELINE_ROW_STATE.COMPARED, kind: v.kind,
    start: iso(v.entry.plannedStart), finish: iso(v.entry.plannedFinish),
    startVariance: v.startVariance, finishVariance: v.finishVariance, text,
  }
}

function reportRow(activity, { depStates, attention, baseline, comparison }) {
  const a = activity
  const dep = stateFor(depStates, a.id)
  const flags = attentionFor(attention, a.id)
  const percent = Number.isInteger(a.percentComplete) ? a.percentComplete : null
  return {
    id: a.id,
    name: typeof a.name === 'string' ? a.name : '',
    isMilestone: a.isMilestone === true,
    typeLabel: a.isMilestone === true ? 'Milestone' : 'Activity',
    plannedStart: iso(a.plannedStart),
    plannedFinish: iso(a.plannedFinish),
    durationDays: activityDuration(a),
    status: a.status,
    statusLabel: ACTIVITY_STATUS_LABELS[a.status] ?? String(a.status ?? ''),
    percentComplete: percent,
    actualStart: iso(a.actualStart),
    actualFinish: iso(a.actualFinish),
    responsibleName: a.responsibleName || '',
    costCodeName: a.costCodeName || '',
    predecessors: dep.entries.map(predecessorText),
    predecessorsShort: dep.entries.map(predecessorShort),
    flags: {
      overdue: flags.overdue,
      blocked: flags.blocked,
      conflict: flags.conflict,
      review: flags.review,
      laterThanBaseline: flags.laterThanBaseline,
    },
    flagLabels: ATTENTION_FLAG_ORDER.filter(f => flags.flags.includes(f)).map(f => ATTENTION_FLAG_LABELS[f]),
    daysLate: flags.daysLate,
    baseline: baselineCell(a, baseline, comparison),
  }
}

// ── The report ───────────────────────────────────────────────────────────────

export const PROGRAMME_REPORT_TITLE = 'Programme Report'

export const PROGRAMME_REPORT_NOTES = [
  'A representation of the current scheduling records at the time it was generated. It is not a saved, issued or approved programme, and generating it creates, approves or freezes no baseline.',
  'Calendar days. Weekends, public holidays and working calendars are not modelled.',
  'Overdue is measured against the current planned dates and today. Later than baseline is a separate measure against the selected approved baseline.',
  'Dependencies are finish-to-start and are shown, never enforced: nothing is rescheduled automatically and there is no critical path.',
  'Progress % is entered by hand and is not verified.',
]

// `activities` — the WHOLE programme (programme order);
// `shown`      — the activities the page is displaying, in display order;
// `depStates`, `attention`, `comparison` — derived from the whole programme.
export function buildProgrammeReport({
  companyName = '', project = null, projectId = '',
  activities = [], shown = [], depStates = null, attention = null,
  baseline = null, comparison = null, scope = null,
} = {}) {
  const whole = (activities ?? []).filter(a => a?.id)
  const visible = (shown ?? []).filter(a => a?.id)
  const baselineInfo = baseline ?? baselineAvailability()
  const ctx = { depStates, attention, baseline: baselineInfo, comparison }
  const rows = visible.map(a => reportRow(a, ctx))
  const scopeInfo = scope ?? programmeScope({ shown: visible.length, total: whole.length })
  const counts = attention?.counts ?? {
    any: 0, overdue: 0, blocked: 0, conflict: 0, review: 0, laterThanBaseline: null,
    conflictLinks: 0, reviewLinks: 0, total: whole.length,
  }
  const outsideScope = attentionOutsideScope(attention, visible)

  return {
    title: PROGRAMME_REPORT_TITLE,
    companyName: String(companyName ?? ''),
    projectName: String(project?.name ?? ''),
    projectId: String(projectId || project?.id || ''),
    scope: scopeInfo,
    baseline: baselineInfo,
    counts,
    inScope: {
      activities: rows.length,
      milestones: rows.filter(r => r.isMilestone).length,
      flagged: rows.filter(r => r.flagLabels.length > 0).length,
    },
    // Flagged activities the scope leaves out. Stated on the report whenever
    // it is not zero.
    attentionOutsideScope: outsideScope,
    rows,
    notes: PROGRAMME_REPORT_NOTES,
  }
}

// A report can be produced once the baseline has settled either way; a
// baseline still loading would export "unavailable" for something that is
// about to exist.
export const isProgrammeReportExportable = (report) =>
  Boolean(report) && report.baseline?.state !== BASELINE_AVAILABILITY.LOADING

// The whole-programme attention summary as label/value pairs, for the report
// header. `null` stays null (not evaluated) for the caller to word.
export function attentionSummaryItems(report) {
  const c = report?.counts ?? {}
  return [
    { key: 'any', label: 'Needing attention', value: c.any ?? 0 },
    { key: 'overdue', label: 'Overdue', value: c.overdue ?? 0 },
    { key: 'blocked', label: 'Blocked', value: c.blocked ?? 0 },
    { key: 'conflict', label: 'Dependency conflict', value: c.conflict ?? 0 },
    { key: 'review', label: 'Dependency requires review', value: c.review ?? 0 },
    { key: 'laterThanBaseline', label: 'Later than baseline', value: c.laterThanBaseline ?? null },
  ]
}

export function outsideScopeText(report) {
  const n = report?.attentionOutsideScope ?? 0
  if (n === 0) return ''
  return `${n} ${n === 1 ? 'activity that needs attention is' : 'activities that need attention are'} outside this filtered scope and ${n === 1 ? 'is' : 'are'} not listed below. The counts above cover the whole programme.`
}
