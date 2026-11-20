import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  BASELINE_AVAILABILITY, BASELINE_ROW_STATE, PROGRAMME_REPORT_NOTES,
  baselineAvailability, programmeScope, predecessorText, predecessorShort, PREDECESSOR_LEGEND, buildProgrammeReport,
  isProgrammeReportExportable, attentionSummaryItems, outsideScopeText,
} from '../../src/lib/programmeReport'
import {
  PROGRAMME_CSV_MARKER, PROGRAMME_CSV_HEADINGS, programmeReportCsv, programmeReportFilename,
} from '../../src/lib/programmeReportCsv'
import { buildProgrammeAttention, filterByAttention, ATTENTION_FLAG } from '../../src/lib/programmeAttention'
import { sortActivities, filterActivities, DUE_FILTER } from '../../src/lib/projectTimeline'
import { dependencyStates } from '../../src/lib/ganttDependencies'
import { baselineComparison } from '../../src/lib/ganttBaseline'

// ── GANTT core completion G2 — programme export and print (ADR-79) ───────────
//
// lib/programmeReport.js builds ONE model; lib/programmeReportCsv.js and the
// printed ProgrammeReport component both serialise it. These tests pin
//
//   1. the rows: activities, milestones, dates, status, progress, links;
//   2. scope: whole, filtered, empty — always stated, warnings never dropped;
//   3. the baseline: selected, none, unavailable — never an invented variance;
//   4. the CSV: headings, dates, numbers, markers, formula-injection safety;
//   5. read-only: no input mutated, no Firebase, no write path;
//   6. the print surface and the reused L2-A print standard (source
//      contracts — the unit runner has no DOM and no print engine).

const read = (rel) => readFileSync(fileURLToPath(new URL(`../../src/${rel}`, import.meta.url)), 'utf8')
const stripComments = (src) =>
  src.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

// ── Fixture: 20 November 2026, local ─────────────────────────────────────────

const NOW = new Date(2026, 10, 20, 12)
const GENERATED = new Date('2026-11-20T03:04:05.000Z')

const act = (id, overrides = {}) => ({
  id, name: id, status: 'not_started', isMilestone: false,
  plannedStart: '2026-12-01', plannedFinish: '2026-12-10', percentComplete: 0, sortOrder: 10, revision: 1,
  ...overrides,
})
const fs = (activityId, lagDays = 0) => ({ activityId, type: 'FS', lagDays })
const entryOf = (a, overrides = {}) => ({
  activityId: a.id, name: a.name, isMilestone: a.isMilestone === true,
  plannedStart: a.plannedStart, plannedFinish: a.plannedFinish, status: a.status,
  percentComplete: a.percentComplete ?? 0, revision: 1, sortOrder: a.sortOrder ?? 0, costCodeId: null,
  ...overrides,
})
const ts = (seconds) => ({ seconds, nanoseconds: 0, toMillis: () => seconds * 1000, toDate: () => new Date(seconds * 1000) })
const snapshotOf = (id, entries) => ({ id, activityCount: entries.length, capturedAt: ts(1), capturedBy: 'u', activities: entries })

const EXCAVATION = act('excavation', {
  name: 'Bulk excavation', sortOrder: 10, status: 'in_progress', plannedStart: '2026-11-01', plannedFinish: '2026-11-10',
  actualStart: '2026-11-01', percentComplete: 60, responsibleName: 'Dig Co', costCodeName: '02 — Earthworks',
})
const FOOTINGS = act('footings', { name: 'Footings', sortOrder: 20, plannedStart: '2026-11-11', plannedFinish: '2026-11-18', predecessors: [fs('excavation', 2)] })
const SLAB     = act('slab',     { name: 'Ground slab', sortOrder: 30, plannedStart: '2026-11-15', plannedFinish: '2026-11-30', predecessors: [fs('footings')] })
const ROOF     = act('roof',     { name: 'Roof', sortOrder: 50, plannedStart: '2026-12-21', plannedFinish: '2026-12-31', predecessors: [fs('oldScope')] })
const OLD      = act('oldScope', { name: 'Old scope', sortOrder: 60, status: 'cancelled', plannedStart: '2026-10-01', plannedFinish: '2026-10-05' })
const SURVEY   = act('survey',   { name: 'Survey', sortOrder: 70, status: 'completed', plannedStart: '2026-10-01', plannedFinish: '2026-10-05', actualStart: '2026-10-01', actualFinish: '2026-10-09', percentComplete: 100 })
const HANDOVER = act('handover', { name: 'Practical completion', sortOrder: 90, isMilestone: true, plannedStart: '2027-01-15', plannedFinish: '2027-01-15' })

const PROGRAMME = sortActivities([EXCAVATION, FOOTINGS, SLAB, ROOF, OLD, SURVEY, HANDOVER])
const HEADER = { id: 'b1', name: 'Contract programme', status: 'approved', approvedAt: ts(1_791_536_000), activityCount: 6 }
// The slab was added after the baseline.
const SNAPSHOT = snapshotOf('b1', [
  entryOf(EXCAVATION, { plannedFinish: '2026-11-08' }),
  entryOf(FOOTINGS, { plannedStart: '2026-11-13', plannedFinish: '2026-11-20' }),
  entryOf(ROOF), entryOf(OLD), entryOf(SURVEY),
  entryOf(HANDOVER, { plannedStart: '2027-01-10', plannedFinish: '2027-01-10' }),
])
const LABEL = 'Baseline 1 — Contract programme'

const DEP = dependencyStates(PROGRAMME, NOW)
const COMPARISON = baselineComparison(PROGRAMME, SNAPSHOT)
const AVAILABLE = baselineAvailability({ header: HEADER, label: LABEL, snapshot: SNAPSHOT })
const NONE = baselineAvailability({})

const attentionWith = (baseline) => buildProgrammeAttention({
  activities: PROGRAMME, depStates: DEP, now: NOW,
  baseline: baseline.available ? { usable: true, header: HEADER, comparison: COMPARISON } : null,
})

function reportOf({ baseline = AVAILABLE, shown = PROGRAMME, scope, activities = PROGRAMME, ...rest } = {}) {
  const attention = attentionWith(baseline)
  return buildProgrammeReport({
    companyName: 'Acme Builders', project: { id: 'p1', name: 'Riverside Stage 2' }, projectId: 'p1',
    activities, shown, depStates: DEP, attention,
    baseline, comparison: baseline.available ? COMPARISON : null,
    scope: scope ?? programmeScope({ shown: shown.length, total: activities.length }),
    ...rest,
  })
}

const rowOf = (report, id) => report.rows.find(r => r.id === id)

// A minimal RFC 4180 reader, so cells are asserted as a spreadsheet reads them.
function parseCsv(text) {
  const rows = []
  let row = []; let cell = ''; let quoted = false; let wasQuoted = false
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i]
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i += 1 }
      else if (c === '"') quoted = false
      else cell += c
    } else if (c === '"') { quoted = true; wasQuoted = true }
    else if (c === ',') { row.push({ v: cell, q: wasQuoted }); cell = ''; wasQuoted = false }
    else if (c === '\r' && text[i + 1] === '\n') { row.push({ v: cell, q: wasQuoted }); rows.push(row); row = []; cell = ''; wasQuoted = false; i += 1 }
    else cell += c
  }
  return rows
}
const csvOf = (report) => parseCsv(programmeReportCsv(report, { generatedAt: GENERATED }))
const tableOf = (parsed) => {
  const at = parsed.findIndex(r => r[0]?.v === 'Activity' && r[1]?.v === 'Type')
  return { headings: parsed[at].map(c => c.v), rows: parsed.slice(at + 1) }
}
const cell = (parsed, activityName, heading) => {
  const { headings, rows } = tableOf(parsed)
  const r = rows.find(x => x[0].v === activityName)
  return r[headings.indexOf(heading)]
}

// ── 1. Rows ──────────────────────────────────────────────────────────────────

describe('report rows: the current activity records, as the page shows them', () => {
  const report = reportOf()

  it('identifies company, project and report', () => {
    expect(report).toMatchObject({ title: 'Programme Report', companyName: 'Acme Builders', projectName: 'Riverside Stage 2', projectId: 'p1' })
  })

  it('a normal activity: dates, duration, status, progress, responsibility', () => {
    expect(rowOf(report, 'excavation')).toMatchObject({
      name: 'Bulk excavation', typeLabel: 'Activity', isMilestone: false,
      plannedStart: '2026-11-01', plannedFinish: '2026-11-10', durationDays: 10,
      status: 'in_progress', statusLabel: 'In progress', percentComplete: 60,
      actualStart: '2026-11-01', actualFinish: null,
      responsibleName: 'Dig Co', costCodeName: '02 — Earthworks',
    })
  })

  it('a milestone is a zero-day point, typed as a milestone', () => {
    expect(rowOf(report, 'handover')).toMatchObject({
      typeLabel: 'Milestone', isMilestone: true, plannedStart: '2027-01-15', plannedFinish: '2027-01-15', durationDays: 0,
    })
    expect(report.inScope).toEqual({ activities: 7, milestones: 1, flagged: 5 })
  })

  it('every status has its label; a cancelled activity stays in the report as history', () => {
    expect(report.rows.map(r => r.statusLabel)).toEqual(
      ['In progress', 'Not started', 'Not started', 'Not started', 'Cancelled', 'Completed', 'Not started'])
    expect(rowOf(report, 'oldScope').flagLabels).toEqual([])
  })

  it('dependencies are written per link, with lag and the link\'s own state', () => {
    expect(rowOf(report, 'footings').predecessors).toEqual(['Bulk excavation (finish to start +2 days — Starts before its predecessor allows)'])
    expect(rowOf(report, 'slab').predecessors).toEqual(['Footings (finish to start — Starts before its predecessor allows)'])
    expect(rowOf(report, 'roof').predecessors).toEqual(['Old scope (finish to start — Predecessor cancelled — requires review)'])
    expect(rowOf(report, 'excavation').predecessors).toEqual([])
    expect(predecessorText({ name: 'A', lagDays: 1, state: 'valid', finished: true })).toBe('A (finish to start +1 day, finished)')
    expect(predecessorText({ activityId: '', state: 'malformed', stateLabel: 'Malformed dependency — requires review' }))
      .toBe('Malformed entry (finish to start — Malformed dependency — requires review)')
  })

  it('the printed table gets the same links in compact form, each still carrying its state', () => {
    expect(rowOf(report, 'footings').predecessorsShort).toEqual([{ text: 'Bulk excavation · FS +2d · conflict', issue: true }])
    expect(rowOf(report, 'roof').predecessorsShort).toEqual([{ text: 'Old scope · FS · cancelled — review', issue: true }])
    expect(rowOf(report, 'excavation').predecessorsShort).toEqual([])
    expect(predecessorShort({ name: 'A', lagDays: 0, state: 'valid', finished: true })).toEqual({ text: 'A · FS · finished', issue: false })
    expect(predecessorShort({ name: 'A', lagDays: 3, state: 'valid', finished: false })).toEqual({ text: 'A · FS +3d', issue: false })
    expect(predecessorShort({ activityId: 'gone', state: 'missing' })).toEqual({ text: 'gone · FS · missing — review', issue: true })
    expect(predecessorShort({ activityId: '', state: 'malformed' })).toEqual({ text: 'Malformed entry · FS · malformed — review', issue: true })
    expect(predecessorShort({ name: 'B', state: 'cycle' }).text).toBe('B · FS · cycle — review')
    // Every row has one compact entry per full entry — none is dropped.
    for (const r of report.rows) expect(r.predecessorsShort).toHaveLength(r.predecessors.length)
    expect(PREDECESSOR_LEGEND).toContain('FS = finish to start')
  })

  it('blocked, conflict, review and overdue indicators are on the row', () => {
    expect(rowOf(report, 'excavation')).toMatchObject({ flagLabels: ['Overdue', 'Later than baseline'], daysLate: 10 })
    expect(rowOf(report, 'footings').flags).toMatchObject({ overdue: true, blocked: true, conflict: true })
    expect(rowOf(report, 'slab').flagLabels).toEqual(['Blocked', 'Dependency conflict'])
    expect(rowOf(report, 'roof').flagLabels).toEqual(['Dependency requires review'])
  })

  it('unusable stored values become null — never a fabricated date or progress', () => {
    const odd = act('odd', { name: 'Odd', plannedStart: '2026-02-30', plannedFinish: 'soon', percentComplete: '50', status: 'paused' })
    const r = buildProgrammeReport({ activities: [odd], shown: [odd] }).rows[0]
    expect(r).toMatchObject({ plannedStart: null, plannedFinish: null, durationDays: null, percentComplete: null, statusLabel: 'paused' })
  })
})

// ── 2. Scope ─────────────────────────────────────────────────────────────────

describe('scope: stated in words, and a filtered report never hides a warning silently', () => {
  it('whole programme', () => {
    const report = reportOf()
    expect(report.scope).toMatchObject({ filtered: false, text: 'Whole programme — 7 of 7 activities' })
    expect(report.attentionOutsideScope).toBe(0)
    expect(outsideScopeText(report)).toBe('')
  })

  it('every filter in force is named', () => {
    const scope = programmeScope({
      search: '  slab ', status: 'not_started', responsibleName: 'Dig Co', hideClosed: true,
      due: DUE_FILTER.OVERDUE, attention: ATTENTION_FLAG.BLOCKED, shown: 1, total: 7,
    })
    expect(scope.filtered).toBe(true)
    expect(scope.text).toBe(
      'Filtered programme — 1 of 7 activities (Attention: Blocked; Status: Not started; Responsible: Dig Co; Due: Overdue only; Completed and cancelled hidden; Search: “slab”)')
    expect(programmeScope({ attention: 'any', shown: 5, total: 7 }).parts).toEqual(['Attention: Any attention flag'])
    expect(programmeScope({ shown: 1, total: 1 }).text).toBe('Whole programme — 1 of 1 activity')
  })

  it('a filtered programme lists only the displayed rows, in displayed order', () => {
    const attention = attentionWith(AVAILABLE)
    const shown = filterByAttention(filterActivities(PROGRAMME, { hideClosed: true }, NOW), attention, ATTENTION_FLAG.BLOCKED)
    const report = reportOf({ shown, scope: programmeScope({ hideClosed: true, attention: ATTENTION_FLAG.BLOCKED, shown: shown.length, total: PROGRAMME.length }) })
    expect(report.rows.map(r => r.id)).toEqual(['footings', 'slab'])
    expect(report.scope.text).toBe('Filtered programme — 2 of 7 activities (Attention: Blocked; Completed and cancelled hidden)')
  })

  it('the counts stay the whole programme\'s, and what the scope leaves out is said', () => {
    const report = reportOf({ shown: [SLAB], scope: programmeScope({ search: 'slab', shown: 1, total: 7 }) })
    expect(report.counts).toMatchObject({ any: 5, overdue: 2, blocked: 2, conflict: 2, review: 1, laterThanBaseline: 2, total: 7 })
    expect(report.attentionOutsideScope).toBe(4)
    expect(outsideScopeText(report)).toBe(
      '4 activities that need attention are outside this filtered scope and are not listed below. The counts above cover the whole programme.')
    expect(outsideScopeText({ attentionOutsideScope: 1 })).toContain('1 activity that needs attention is outside')
  })

  it('a predecessor outside the scope is still named on its successor\'s row, with its state', () => {
    const report = reportOf({ shown: [SLAB] })
    expect(report.rows[0].predecessors).toEqual(['Footings (finish to start — Starts before its predecessor allows)'])
    expect(report.rows[0].flags).toMatchObject({ blocked: true, conflict: true })
  })

  it('an empty programme and a scope that matches nothing are both reportable', () => {
    const empty = buildProgrammeReport({ companyName: 'Acme', project: { name: 'P' }, activities: [], shown: [] })
    expect(empty.rows).toEqual([])
    expect(empty.scope.text).toBe('Whole programme — 0 of 0 activities')
    expect(empty.counts).toMatchObject({ any: 0, laterThanBaseline: null })
    expect(isProgrammeReportExportable(empty)).toBe(true)

    const none = reportOf({ shown: [], scope: programmeScope({ search: 'zzz', shown: 0, total: 7 }) })
    expect(none.rows).toEqual([])
    expect(none.attentionOutsideScope).toBe(5)
  })
})

// ── 3. Baseline ──────────────────────────────────────────────────────────────

describe('baseline: the selected approved version, or an explanation — never an invented variance', () => {
  it('availability reduces the page\'s reads to one state, in precedence order', () => {
    const state = (o) => baselineAvailability(o).state
    expect(state({ headersLoading: true, header: HEADER, snapshot: SNAPSHOT })).toBe(BASELINE_AVAILABILITY.LOADING)
    expect(state({ headersError: true })).toBe(BASELINE_AVAILABILITY.UNAVAILABLE)
    expect(state({})).toBe(BASELINE_AVAILABILITY.NONE)
    expect(state({ header: HEADER, snapshotLoading: true })).toBe(BASELINE_AVAILABILITY.LOADING)
    expect(state({ header: HEADER, snapshotError: true })).toBe(BASELINE_AVAILABILITY.UNAVAILABLE)
    expect(state({ header: HEADER, snapshot: null })).toBe(BASELINE_AVAILABILITY.UNUSABLE)
    expect(state({ header: HEADER, snapshot: { activities: 'x' } })).toBe(BASELINE_AVAILABILITY.UNUSABLE)
    expect(state({ header: HEADER, snapshot: SNAPSHOT })).toBe(BASELINE_AVAILABILITY.AVAILABLE)
  })

  it('a selected baseline is referenced by its label and approval day', () => {
    expect(AVAILABLE).toMatchObject({ available: true, label: LABEL })
    expect(AVAILABLE.approvedOn).toMatch(/^2026-10-(09|10)$/)
    expect(AVAILABLE.text).toBe(`Compared with ${LABEL} — planning evidence, not a contractual programme acceptance.`)
  })

  it('every unavailable state has its own explanation and carries no label', () => {
    expect(NONE).toMatchObject({ available: false, label: '', approvedOn: null })
    expect(NONE.text).toContain('No approved baseline exists')
    expect(baselineAvailability({ headersError: true, label: 'x' }).text).toContain('could not be loaded')
    expect(baselineAvailability({ header: HEADER, label: LABEL, snapshot: null }).text).toContain('its snapshot document could not be found')
    for (const s of [BASELINE_AVAILABILITY.UNAVAILABLE, BASELINE_AVAILABILITY.UNUSABLE]) {
      expect(baselineAvailability(s === BASELINE_AVAILABILITY.UNAVAILABLE ? { headersError: true } : { header: HEADER }).text)
        .toContain('not zero')
    }
  })

  it('with a baseline: baseline dates and signed calendar-day variance', () => {
    const report = reportOf()
    expect(rowOf(report, 'excavation').baseline).toMatchObject({
      state: BASELINE_ROW_STATE.COMPARED, start: '2026-11-01', finish: '2026-11-08', startVariance: 0, finishVariance: 2,
    })
    // Earlier than baseline is a NEGATIVE variance, and not a flag.
    expect(rowOf(report, 'footings').baseline).toMatchObject({ startVariance: -2, finishVariance: -2 })
    expect(rowOf(report, 'footings').flags.laterThanBaseline).toBe(false)
    expect(rowOf(report, 'handover').baseline).toMatchObject({ finishVariance: 5, text: 'Milestone planned +5 days later than baseline' })
    // A recorded late finish is reported as history in the comparison text.
    expect(rowOf(report, 'survey').baseline.text).toBe('Unchanged from baseline. Finished 4 days after the baseline finish')
  })

  it('an activity the baseline cannot compare says why, with no day figure', () => {
    const report = reportOf()
    expect(rowOf(report, 'slab').baseline).toEqual({
      state: BASELINE_ROW_STATE.NOT_COMPARED, kind: 'added_after', start: null, finish: null,
      startVariance: null, finishVariance: null, text: 'Added after the baseline was approved',
    })
    expect(rowOf(report, 'oldScope').baseline).toMatchObject({
      state: BASELINE_ROW_STATE.NOT_COMPARED, finishVariance: null, text: 'Already cancelled when the baseline was approved',
    })
  })

  it('no approved baseline: no variance, no baseline date and no later-than-baseline flag anywhere', () => {
    const report = reportOf({ baseline: NONE })
    for (const r of report.rows) {
      expect(r.baseline).toEqual({
        state: BASELINE_ROW_STATE.NO_BASELINE, kind: 'no_baseline', start: null, finish: null,
        startVariance: null, finishVariance: null, text: '',
      })
      expect(r.flags.laterThanBaseline).toBe(false)
    }
    expect(report.counts.laterThanBaseline).toBeNull()
    expect(attentionSummaryItems(report).find(i => i.key === 'laterThanBaseline').value).toBeNull()
    expect(rowOf(report, 'excavation').flagLabels).toEqual(['Overdue'])
  })

  it('a comparison passed WITHOUT an available baseline is ignored', () => {
    const attention = attentionWith(NONE)
    const report = buildProgrammeReport({ activities: PROGRAMME, shown: PROGRAMME, depStates: DEP, attention, baseline: NONE, comparison: COMPARISON })
    expect(report.rows.every(r => r.baseline.finishVariance === null && r.baseline.state === BASELINE_ROW_STATE.NO_BASELINE)).toBe(true)
  })

  it('a report is not exportable while the baseline is still loading, and is once it settles either way', () => {
    const loading = baselineAvailability({ header: HEADER, snapshotLoading: true })
    expect(isProgrammeReportExportable(reportOf({ baseline: loading }))).toBe(false)
    expect(isProgrammeReportExportable(reportOf())).toBe(true)
    expect(isProgrammeReportExportable(reportOf({ baseline: NONE }))).toBe(true)
    expect(isProgrammeReportExportable(null)).toBe(false)
  })
})

// ── 4. CSV ───────────────────────────────────────────────────────────────────

describe('CSV: clear headings, real dates and numbers, explicit markers', () => {
  const parsed = csvOf(reportOf())

  it('the header block identifies the report, its moment, its scope and its baseline', () => {
    const meta = Object.fromEntries(parsed.filter(r => r.length >= 2).map(r => [r[0].v, r[1].v]))
    expect(parsed[0][0].v).toBe('Constrap Programme Report')
    expect(meta.Company).toBe('Acme Builders')
    expect(meta.Project).toBe('Riverside Stage 2')
    expect(meta.Generated).toBe('2026-11-20T03:04:05.000Z')
    expect(meta.Scope).toBe('Whole programme — 7 of 7 activities')
    expect(meta.Baseline).toBe(LABEL)
    expect(meta['Baseline approved']).toMatch(/^2026-10-(09|10)$/)
    expect(parsed.find(r => r[0].v === 'Generated')[2].v).toContain('exporting creates no baseline')
  })

  it('the whole-programme attention counts are written as numbers', () => {
    const count = (label) => parsed.find(r => r[0].v === label)[1]
    expect(count('Needing attention')).toEqual({ v: '5', q: false })
    expect(count('Overdue').v).toBe('2')
    expect(count('Blocked').v).toBe('2')
    expect(count('Dependency conflict').v).toBe('2')
    expect(count('Dependency requires review').v).toBe('1')
    expect(count('Later than baseline')).toEqual({ v: '2', q: false })
  })

  it('the table has the documented headings and one line per displayed activity', () => {
    const { headings, rows } = tableOf(parsed)
    expect(headings).toEqual(PROGRAMME_CSV_HEADINGS)
    expect(headings).toEqual(expect.arrayContaining([
      'Planned start', 'Planned finish', 'Status', 'Progress (%)', 'Predecessors', 'Blocked',
      'Dependency conflict', 'Dependency requires review', 'Baseline finish', 'Finish variance (calendar days)',
    ]))
    expect(rows.map(r => r[0].v)).toEqual(['Bulk excavation', 'Footings', 'Ground slab', 'Roof', 'Old scope', 'Survey', 'Practical completion'])
    for (const r of rows) expect(r).toHaveLength(PROGRAMME_CSV_HEADINGS.length)
  })

  it('dates are ISO text; durations, progress and variances are unquoted numbers', () => {
    expect(cell(parsed, 'Bulk excavation', 'Planned start')).toEqual({ v: '2026-11-01', q: true })
    expect(cell(parsed, 'Bulk excavation', 'Baseline finish')).toEqual({ v: '2026-11-08', q: true })
    expect(cell(parsed, 'Bulk excavation', 'Duration (calendar days)')).toEqual({ v: '10', q: false })
    expect(cell(parsed, 'Bulk excavation', 'Progress (%)')).toEqual({ v: '60', q: false })
    expect(cell(parsed, 'Bulk excavation', 'Days overdue')).toEqual({ v: '10', q: false })
    expect(cell(parsed, 'Bulk excavation', 'Finish variance (calendar days)')).toEqual({ v: '2', q: false })
    // A negative variance is a NUMBER, not text and not a formula.
    expect(cell(parsed, 'Footings', 'Finish variance (calendar days)')).toEqual({ v: '-2', q: false })
    // A genuine zero stays a zero.
    expect(cell(parsed, 'Survey', 'Finish variance (calendar days)')).toEqual({ v: '0', q: false })
    expect(cell(parsed, 'Practical completion', 'Duration (calendar days)')).toEqual({ v: '0', q: false })
  })

  it('type, status and the flags are words', () => {
    expect(cell(parsed, 'Practical completion', 'Type').v).toBe('Milestone')
    expect(cell(parsed, 'Bulk excavation', 'Type').v).toBe('Activity')
    expect(cell(parsed, 'Old scope', 'Status').v).toBe('Cancelled')
    expect(cell(parsed, 'Ground slab', 'Blocked').v).toBe('YES')
    expect(cell(parsed, 'Ground slab', 'Dependency conflict').v).toBe('YES')
    expect(cell(parsed, 'Ground slab', 'Overdue').v).toBe('NO')
    expect(cell(parsed, 'Roof', 'Dependency requires review').v).toBe('YES')
    expect(cell(parsed, 'Bulk excavation', 'Later than baseline').v).toBe('YES')
    expect(cell(parsed, 'Footings', 'Predecessors').v).toBe('Bulk excavation (finish to start +2 days — Starts before its predecessor allows)')
  })

  it('a missing value is an explicit marker — never blank, never zero', () => {
    const M = PROGRAMME_CSV_MARKER
    expect(cell(parsed, 'Bulk excavation', 'Actual finish').v).toBe(M.NOT_RECORDED)
    expect(cell(parsed, 'Footings', 'Actual start').v).toBe(M.NOT_RECORDED)
    expect(cell(parsed, 'Footings', 'Responsible').v).toBe(M.NOT_ASSIGNED)
    expect(cell(parsed, 'Footings', 'Cost code').v).toBe(M.NONE)
    expect(cell(parsed, 'Bulk excavation', 'Predecessors').v).toBe(M.NONE)
    expect(cell(parsed, 'Ground slab', 'Days overdue').v).toBe(M.NOT_OVERDUE)
    // Added after the baseline: no baseline date, no day figure, and the reason.
    expect(cell(parsed, 'Ground slab', 'Baseline finish').v).toBe(M.NOT_IN_BASELINE)
    expect(cell(parsed, 'Ground slab', 'Finish variance (calendar days)').v).toBe(M.NOT_COMPARED)
    expect(cell(parsed, 'Ground slab', 'Baseline comparison').v).toBe('Added after the baseline was approved')
    const { rows } = tableOf(parsed)
    for (const r of rows) for (const c of r) expect(c.v).not.toBe('')
  })

  it('no approved baseline: every baseline cell says so, and nothing is a zero variance', () => {
    const none = csvOf(reportOf({ baseline: NONE }))
    const M = PROGRAMME_CSV_MARKER
    expect(none.find(r => r[0].v === 'Baseline')[1].v).toBe(M.NO_BASELINE)
    expect(none.find(r => r[0].v === 'Baseline')[2].v).toContain('No approved baseline exists')
    expect(none.find(r => r[0].v === 'Baseline approved')[1].v).toBe(M.NO_BASELINE)
    expect(none.find(r => r[0].v === 'Later than baseline')[1].v).toBe(M.NOT_EVALUATED)
    for (const name of ['Bulk excavation', 'Survey', 'Practical completion']) {
      expect(cell(none, name, 'Later than baseline').v).toBe(M.NOT_EVALUATED)
      expect(cell(none, name, 'Baseline start').v).toBe(M.NO_BASELINE)
      expect(cell(none, name, 'Baseline finish').v).toBe(M.NO_BASELINE)
      expect(cell(none, name, 'Start variance (calendar days)').v).toBe(M.NO_BASELINE)
      expect(cell(none, name, 'Finish variance (calendar days)').v).toBe(M.NO_BASELINE)
    }
    // The current-plan flags are untouched by the absence of a baseline.
    expect(cell(none, 'Bulk excavation', 'Overdue').v).toBe('YES')
  })

  it('a baseline that failed to load is UNAVAILABLE — distinct from none approved', () => {
    const failed = baselineAvailability({ header: HEADER, label: LABEL, snapshotError: true })
    const out = csvOf(reportOf({ baseline: failed }))
    expect(out.find(r => r[0].v === 'Baseline')[1].v).toBe(PROGRAMME_CSV_MARKER.UNAVAILABLE)
    expect(cell(out, 'Bulk excavation', 'Finish variance (calendar days)').v).toBe(PROGRAMME_CSV_MARKER.UNAVAILABLE)
  })

  it('a filtered export states its scope and what it leaves out', () => {
    const out = csvOf(reportOf({ shown: [SLAB], scope: programmeScope({ attention: ATTENTION_FLAG.CONFLICT, search: 'slab', shown: 1, total: 7 }) }))
    expect(out.find(r => r[0].v === 'Scope')[1].v).toBe('Filtered programme — 1 of 7 activities (Attention: Dependency conflict; Search: “slab”)')
    expect(out.find(r => r[0].v === 'Activities listed')[1]).toEqual({ v: '1', q: false })
    expect(out.some(r => r[0].v === 'Note' && r[1].v.startsWith('4 activities that need attention are outside this filtered scope'))).toBe(true)
    expect(tableOf(out).rows).toHaveLength(1)
    // The whole-programme counts are still the whole programme's.
    expect(out.find(r => r[0].v === 'Blocked')[1].v).toBe('2')
  })

  it('an empty programme and an empty scope each write one explicit line', () => {
    const empty = csvOf(buildProgrammeReport({ companyName: 'Acme', project: { name: 'P' }, activities: [], shown: [] }))
    expect(tableOf(empty).rows.map(r => r[0].v)).toEqual(['No activities in this programme'])
    const none = csvOf(reportOf({ shown: [], scope: programmeScope({ search: 'zzz', shown: 0, total: 7 }) }))
    expect(tableOf(none).rows.map(r => r[0].v)).toEqual(['No activity matches this scope'])
  })

  it('every report note is in the file', () => {
    const notes = parsed.filter(r => r[0].v === 'Note').map(r => r[1].v)
    expect(notes).toEqual(PROGRAMME_REPORT_NOTES)
    expect(notes.join(' ')).toMatch(/creates, approves or freezes no baseline/)
  })

  it('CRLF line endings; a missing company or project is a marker, not a blank', () => {
    const text = programmeReportCsv(reportOf(), { generatedAt: GENERATED })
    expect(text.endsWith('\r\n')).toBe(true)
    expect(text.replace(/\r\n/g, '')).not.toMatch(/\r/)
    const anon = csvOf(buildProgrammeReport({ activities: [], shown: [] }))
    expect(anon.find(r => r[0].v === 'Company')[1].v).toBe(PROGRAMME_CSV_MARKER.UNAVAILABLE)
    expect(anon.find(r => r[0].v === 'Project')[1].v).toBe(PROGRAMME_CSV_MARKER.UNAVAILABLE)
  })

  it('refuses a loading report and a missing or invalid generation time', () => {
    const loading = reportOf({ baseline: baselineAvailability({ headersLoading: true }) })
    expect(() => programmeReportCsv(loading, { generatedAt: GENERATED })).toThrow(/still loading/)
    expect(() => programmeReportCsv(reportOf())).toThrow(/generation time/)
    expect(() => programmeReportCsv(reportOf(), { generatedAt: new Date('nope') })).toThrow(/generation time/)
    expect(() => programmeReportCsv(null, { generatedAt: GENERATED })).toThrow()
  })

  it('the filename is a safe slug with the local date', () => {
    const at = new Date(2026, 10, 20, 9)
    expect(programmeReportFilename({ projectName: 'Riverside / Stage 2: "Fit-out"' }, at)).toBe('constrap-programme-report-riverside-stage-2-fit-out-2026-11-20.csv')
    expect(programmeReportFilename({ projectName: '', projectId: 'p1' }, at)).toBe('constrap-programme-report-p1-2026-11-20.csv')
    expect(programmeReportFilename({}, at)).toBe('constrap-programme-report-project-2026-11-20.csv')
  })
})

describe('CSV formula-injection protection (lib/csv.js, reused)', () => {
  const eq = String.fromCharCode(0x3D)
  const HOSTILE = [
    `${eq}HYPERLINK("http://evil.example","Open")`,
    '+1+1',
    '-2+3',
    '@SUM(A1:A9)',
    `\t${eq}1+1`,
    `   ${eq}cmd|' /C calc'!A0`,
  ]

  it.each(HOSTILE)('an activity named %j is written as text, never as a formula', (name) => {
    const hostile = act('h', { name, responsibleName: name, costCodeName: name, sortOrder: 1 })
    const report = buildProgrammeReport({
      companyName: name, project: { name }, activities: [hostile], shown: [hostile],
      depStates: dependencyStates([hostile], NOW),
    })
    const text = programmeReportCsv(report, { generatedAt: GENERATED })
    const parsedRows = parseCsv(text)
    const { headings, rows } = tableOf(parsedRows)
    const row = rows[0]
    for (const h of ['Activity', 'Responsible', 'Cost code']) {
      const c = row[headings.indexOf(h)]
      expect(c.q).toBe(true)
      expect(c.v.startsWith("'")).toBe(true)
      expect(c.v.slice(1)).toBe(name)
    }
    for (const label of ['Company', 'Project']) {
      const c = parsedRows.find(r => r[0].v === label)[1]
      expect(c).toEqual({ v: `'${name}`, q: true })
    }
    // No unquoted cell anywhere starts with a formula trigger except a
    // genuine negative number.
    for (const r of parsedRows) for (const c of r) {
      if (!c.q && c.v !== '') expect(c.v).toMatch(/^-?\d+(\.\d+)?$/)
    }
  })

  it('a hostile PREDECESSOR name inside the dependency cell cannot start the cell', () => {
    const p = act('p', { name: `${eq}EVIL()`, sortOrder: 1, plannedStart: '2026-11-01', plannedFinish: '2026-11-02' })
    const s = act('s', { name: 'Successor', sortOrder: 2, predecessors: [fs('p')] })
    const list = [p, s]
    const report = buildProgrammeReport({ project: { name: 'P' }, activities: list, shown: [s], depStates: dependencyStates(list, NOW) })
    const c = cell(csvOf(report), 'Successor', 'Predecessors')
    expect(c).toEqual({ v: `'${eq}EVIL() (finish to start)`, q: true })
  })

  it('quotes, commas and line breaks in a name survive intact', () => {
    const tricky = act('t', { name: 'Slab "A", level 1\nwest', sortOrder: 1 })
    const report = buildProgrammeReport({ project: { name: 'P' }, activities: [tricky], shown: [tricky] })
    expect(tableOf(csvOf(report)).rows[0][0]).toEqual({ v: 'Slab "A", level 1\nwest', q: true })
  })

  it('the serialiser goes through csvRows and builds no cell by hand', () => {
    const src = stripComments(read('lib/programmeReportCsv.js'))
    expect(src).toContain("import { csvRows, filenameSlug } from './csv'")
    expect(src).toContain('return csvRows(rows)')
    expect(src).not.toMatch(/\.join\(','\)|\\r\\n/)
  })
})

// ── 5. Read-only ─────────────────────────────────────────────────────────────

describe('exporting is read-only: no input is changed and no write path exists', () => {
  const deepFreeze = (o) => {
    if (o && typeof o === 'object' && !Object.isFrozen(o) && !(o instanceof Map)) {
      Object.freeze(o)
      for (const v of Object.values(o)) deepFreeze(v)
    }
    return o
  }

  it('building the report and the CSV from frozen records neither throws nor mutates', () => {
    const activities = deepFreeze(JSON.parse(JSON.stringify(PROGRAMME)))
    const snapshot = deepFreeze(JSON.parse(JSON.stringify({ ...SNAPSHOT, capturedAt: null })))
    const header = deepFreeze({ id: 'b1', name: 'Contract programme', status: 'approved', approvedAt: { seconds: 1_791_536_000, nanoseconds: 0 } })
    const before = JSON.stringify([activities, snapshot, header])

    const depStates = dependencyStates(activities, NOW)
    const comparison = baselineComparison(activities, snapshot)
    const baseline = baselineAvailability({ header, label: LABEL, snapshot })
    const attention = buildProgrammeAttention({ activities, depStates, now: NOW, baseline: { usable: true, header, comparison } })
    const report = buildProgrammeReport({ companyName: 'Acme', project: deepFreeze({ name: 'P' }), activities, shown: activities, depStates, attention, baseline, comparison })
    const first = programmeReportCsv(report, { generatedAt: GENERATED })

    expect(JSON.stringify([activities, snapshot, header])).toBe(before)
    // Deterministic: the same records and the same moment give the same file.
    expect(programmeReportCsv(report, { generatedAt: GENERATED })).toBe(first)
  })

  it('the report, CSV and attention modules are pure: no Firebase, no React, no clock, no storage', () => {
    for (const rel of ['lib/programmeReport.js', 'lib/programmeReportCsv.js', 'lib/programmeAttention.js']) {
      const src = stripComments(read(rel))
      expect(src, rel).not.toMatch(/firebase|firestore|from 'react|localStorage|sessionStorage|fetch\(|globalThis|window\./)
      expect(src, rel).not.toMatch(/setDoc|updateDoc|addDoc|deleteDoc|writeBatch|runTransaction|serverTimestamp/)
      expect(src.replace(/now = new Date\(\)/g, ''), rel).not.toMatch(/new Date\(|Date\.now/)
    }
  })

  it('the printed report component has no hook, no read and no write', () => {
    const src = stripComments(read('pages/project/timeline/ProgrammeReport.jsx'))
    expect(src).not.toMatch(/use[A-Z]\w*\(|firebase|onClick|<button|<input|<select|<form/)
    expect(src).not.toMatch(/new Date\(/)
  })

  it('the page\'s export and print handlers call no write callback and capture no baseline', () => {
    const page = stripComments(read('pages/project/ProjectTimeline.jsx'))
    const handlers = page.slice(page.indexOf('function handleExportCsv()'), page.indexOf('const setScale = '))
    expect(handlers).toContain('programmeReportCsv(report, { generatedAt: at })')
    expect(handlers).toContain('print()')
    expect(handlers).not.toMatch(/createActivity|updateActivity|cancelActivity|quickUpdateActivity|captureBaseline|approveBaseline|withdrawBaseline|checkDrift/)
    expect(handlers).not.toMatch(/setCapturing|setReviewing|setBaselineChoice|setEditing/)
    // The page still holds no Firestore write of its own and stores nothing.
    expect(page).not.toMatch(/localStorage|sessionStorage|setDoc|updateDoc|addDoc|writeBatch|from 'firebase/)
  })

  it('no new collection, rule or function exists for the export', () => {
    const hooks = stripComments(read('hooks/useProjectActivities.jsx')) + stripComments(read('hooks/useProgrammeBaselines.jsx'))
    expect(hooks).not.toMatch(/programmeReport|programmeExport|issuedProgramme/i)
    const rules = readFileSync(fileURLToPath(new URL('../../firestore.rules', import.meta.url)), 'utf8')
    expect(rules).not.toMatch(/programmeReport|programmeExport|issuedProgramme/i)
  })
})

// ── 6. Print surface ─────────────────────────────────────────────────────────

describe('print: a schedule table under the existing premium print standard', () => {
  const css = read('index.css')
  const component = stripComments(read('pages/project/timeline/ProgrammeReport.jsx'))
  const page = stripComments(read('pages/project/ProjectTimeline.jsx'))
  const block = css.slice(css.indexOf('GANTT™ Programme Report (ADR-79)'))

  it('the report carries the L2-A report scope, so every existing print rule applies', () => {
    expect(component).toContain('<article className="commercial-report programme-report flex-col gap-4"')
    for (const cls of ['report-header', 'report-card', 'report-table-wrap', 'report-table', 'report-figure', 'report-footnote']) {
      expect(component, cls).toContain(cls)
    }
    // The rules it inherits: ink palette, hidden chrome, landscape page,
    // repeated header row, no row split across pages.
    expect(css).toContain('@page commercial-report { size: A4 landscape; margin: 12mm; }')
    expect(css).toContain('.commercial-report .report-table thead { display: table-header-group; }')
    expect(css).toMatch(/\.commercial-report \.report-table tr \{ break-inside: avoid; page-break-inside: avoid; \}/)
    expect(css).toContain('body:has(.commercial-report) [data-print-hide],')
    expect(css).toContain('--color-brand-text:      #0B1629;')
  })

  it('it is never shown on screen and is un-hidden only in print', () => {
    expect(block).toMatch(/^\.commercial-report\.programme-report \{ display: none; \}$/m)
    const print = block.slice(block.indexOf('@media print'))
    expect(print).toContain('.commercial-report.programme-report { display: flex !important; }')
  })

  it('long names and dependency lists wrap instead of clipping; no new colour or font is introduced', () => {
    expect(block).toContain('white-space: normal !important; overflow-wrap: break-word;')
    expect(block).not.toMatch(/#[0-9a-fA-F]{3,8}\b|font-family|overflow:\s*hidden/)
    expect(component).toContain('programme-report-name')
    expect(component).toContain('programme-report-wrap')
    // Dates never wrap mid-date.
    expect(component).toContain('whitespace-nowrap tabular-nums')
  })

  it('every new print selector is scoped to the report', () => {
    const selectors = block.match(/^[^{}@/*]+\{/gm).map(s => s.trim())
    expect(selectors.length).toBeGreaterThan(5)
    for (const s of selectors) expect(s, s).toMatch(/^\.commercial-report\.programme-report/)
  })

  it('it prints a TABLE with header cells and a caption — never the interactive chart', () => {
    expect(component).toContain('<table className="report-table w-full border-collapse">')
    expect(component).toContain('<caption className="sr-only">')
    expect(component).toContain('scope="col"')
    expect(component).toContain('scope="row"')
    expect(component).not.toMatch(/TimelineGantt|<svg|ActivityTable|ActivityCards/)
  })

  it('the metadata printed: company, project, title, generation time, scope, baseline', () => {
    expect(component).toContain('Constrap · GANTT™ {report.title}')
    expect(component).toContain("{report.projectName || 'Project'}")
    expect(component).toContain('{report.companyName}')
    expect(component).toContain('{report.scope.text}')
    expect(component).toContain('<time dateTime={generatedAt.toISOString()}>{stamp(generatedAt)}</time>')
    expect(component).toContain('{b.text}')
    expect(component).toContain('printing creates no baseline')
    expect(component).toContain('{outside && ')
    expect(component).toContain("{item.value === null ? 'Not evaluated' : item.value}")
    expect(component).toContain('{PREDECESSOR_LEGEND}')
  })

  it('the baseline columns exist only when a baseline is available', () => {
    expect(component).toContain('const withBaseline = b.available')
    expect(component).toContain('{withBaseline && <th scope="col" className={thCls}>Baseline finish · variance</th>}')
    expect(component).toContain('{withBaseline && <BaselineCell row={row} />}')
    // No day figure is printed for a row the baseline cannot compare.
    expect(component).toContain("<span className=\"block text-brand-muted\">{b.text || 'Not compared'}</span>")
  })

  it('the page mounts the report only while printing and hides everything interactive in that print', () => {
    expect(page).toContain('{printable && <ProgrammeReport report={report} generatedAt={printAt} />}')
    expect(page).toContain('<div data-print-hide>')
    // The mounting itself lives in hooks/usePrintMoment.jsx — pinned in
    // programmePrintAndBaseline.test.js.
    expect(page).toContain('const { printAt, print } = usePrintMoment()')
    // The dialogs sit inside the hidden wrapper too.
    expect(page.indexOf('<div data-print-hide>')).toBeLessThan(page.indexOf('<ActivityEditorModal'))
    expect(page.lastIndexOf('</div>\n    </div>')).toBeGreaterThan(page.indexOf('<BaselineReviewModal'))
  })

  it('CSV and print serialise the SAME model of the SAME displayed set', () => {
    expect(page).toMatch(/activities: ordered, shown: filtered, depStates, attention,/)
    expect(page).toContain('baseline: baselineInfo, comparison,')
    expect(page).toContain('shown: filtered.length, total: ordered.length,')
    expect(page).toContain('<Btn variant="ghost" onClick={handleExportCsv} disabled={!exportable}>Export CSV</Btn>')
    expect(page).toContain('<Btn variant="ghost" onClick={handlePrint} disabled={!exportable}>Print / Save as PDF</Btn>')
    expect(page).toContain('{report.scope.text}')
    // Saved through the app's one object-URL path.
    expect(page).toContain('saveBlob({ blob, fileName: filename })')
    expect(page).not.toMatch(/createObjectURL/)
  })
})
