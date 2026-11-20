import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  BASELINE_AVAILABILITY, BASELINE_ROW_STATE, baselineAvailability, buildProgrammeReport, programmeScope,
} from '../../src/lib/programmeReport'
import { PROGRAMME_CSV_MARKER, programmeReportCsv } from '../../src/lib/programmeReportCsv'
import { buildProgrammeAttention, filterByAttention, ATTENTION_FLAG } from '../../src/lib/programmeAttention'
import {
  BASELINE_PROBLEM, BASELINE_PROBLEM_TEXT, baselineSnapshotProblem, resolveActiveBaseline,
} from '../../src/lib/pulseSchedule'
import { evaluatePulse, INDICATOR, PULSE_SOURCES, PULSE_STATE } from '../../src/lib/pulse'
import { sortActivities } from '../../src/lib/projectTimeline'
import { dependencyStates } from '../../src/lib/ganttDependencies'
import { baselineComparison, baselineVersionLabel, activeBaseline, selectedBaseline } from '../../src/lib/ganttBaseline'

// ── GANTT core completion — architect corrections (ADR-79) ───────────────────
//
//   A. PRINT: the report is mounted SYNCHRONOUSLY (react-dom flushSync) before
//      the browser lays out the print — on the button and inside `beforeprint`
//      — and removed on `afterprint`; what is printed is the page's current
//      report model (filters and selected baseline included).
//   B. BASELINE INTEGRITY: the GANTT tab judges its SELECTED baseline with the
//      same check PULSE applies to the ACTIVE one. An invalid or incomplete
//      baseline yields no variance, no flag and no count — never a zero.
//      With the same valid baseline, GANTT and PULSE agree; with a historical
//      one the difference is stated in the interface and in the exports.
//
// Source contracts below read files: the unit runner is plain Node with no
// DOM and no print engine. The mechanism itself was exercised once in
// headless Chrome (TESTING.md §64 → "Print mechanism run").

const read = (rel) => readFileSync(fileURLToPath(new URL(`../../src/${rel}`, import.meta.url)), 'utf8')
const stripComments = (src) =>
  src.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

const NOW = new Date(2026, 10, 20, 12)
const GENERATED = new Date('2026-11-20T03:04:05.000Z')
const ts = (seconds) => ({ seconds, nanoseconds: 0, toMillis: () => seconds * 1000, toDate: () => new Date(seconds * 1000) })
const act = (id, overrides = {}) => ({
  id, name: id, status: 'not_started', isMilestone: false,
  plannedStart: '2026-12-01', plannedFinish: '2026-12-10', percentComplete: 0, sortOrder: 10, revision: 1,
  ...overrides,
})
const entryOf = (a, overrides = {}) => ({
  activityId: a.id, name: a.name, isMilestone: a.isMilestone === true,
  plannedStart: a.plannedStart, plannedFinish: a.plannedFinish, status: a.status,
  percentComplete: a.percentComplete ?? 0, revision: 1, sortOrder: a.sortOrder ?? 0, costCodeId: null,
  ...overrides,
})
const snapshotOf = (id, entries, extra = {}) => ({ id, activityCount: entries.length, capturedAt: ts(1), capturedBy: 'u', activities: entries, ...extra })

const EXCAVATION = act('excavation', { sortOrder: 10, status: 'in_progress', plannedStart: '2026-11-01', plannedFinish: '2026-11-10', actualStart: '2026-11-01' })
const FOOTINGS   = act('footings',   { sortOrder: 20, plannedStart: '2026-11-11', plannedFinish: '2026-11-18', predecessors: [{ activityId: 'excavation', type: 'FS', lagDays: 0 }] })
const FRAME      = act('frame',      { sortOrder: 30, plannedStart: '2026-12-01', plannedFinish: '2026-12-20' })
const HANDOVER   = act('handover',   { sortOrder: 90, isMilestone: true, plannedStart: '2027-01-15', plannedFinish: '2027-01-15' })
const PROGRAMME = sortActivities([EXCAVATION, FOOTINGS, FRAME, HANDOVER])

// Two approved versions. b1 (historical, the original): frame and handover
// were both earlier. b2 (active): only handover was earlier.
const B1 = { id: 'b1', name: 'Tender programme', status: 'approved', approvedAt: ts(1_790_000_000), activityCount: 4 }
const B2 = { id: 'b2', name: 'Contract programme', status: 'approved', approvedAt: ts(1_791_536_000), activityCount: 4 }
const HEADERS = [B1, B2]
const SNAP1 = snapshotOf('b1', [
  entryOf(EXCAVATION), entryOf(FOOTINGS), entryOf(FRAME, { plannedFinish: '2026-12-15' }),
  entryOf(HANDOVER, { plannedStart: '2026-12-20', plannedFinish: '2026-12-20' }),
])
const SNAP2 = snapshotOf('b2', [
  entryOf(EXCAVATION), entryOf(FOOTINGS), entryOf(FRAME),
  entryOf(HANDOVER, { plannedStart: '2027-01-10', plannedFinish: '2027-01-10' }),
])
const DEP = dependencyStates(PROGRAMME, NOW)

// What the page derives, in the page's order: availability → comparison only
// when available → attention → displayed set → report.
function pageState({ choice = 'active', snapshot, filter = '', headers = HEADERS } = {}) {
  const header = selectedBaseline(headers, choice)
  const snap = snapshot === undefined ? (header?.id === 'b1' ? SNAP1 : SNAP2) : snapshot
  const baseline = baselineAvailability({ headers, header, label: header ? baselineVersionLabel(headers, header) : '', snapshot: snap })
  const comparison = baseline.available ? baselineComparison(PROGRAMME, snap) : null
  const attention = buildProgrammeAttention({ activities: PROGRAMME, depStates: DEP, now: NOW, baseline: { usable: baseline.available, header, comparison } })
  const shown = filterByAttention(PROGRAMME, attention, filter)
  const report = buildProgrammeReport({
    companyName: 'Acme', project: { name: 'Riverside' }, activities: PROGRAMME, shown, depStates: DEP, attention,
    baseline, comparison, scope: programmeScope({ attention: filter, shown: shown.length, total: PROGRAMME.length }),
  })
  return { header, baseline, comparison, attention, shown, report }
}

const pulseOf = (snapshot, headers = HEADERS) => {
  const sourceStates = Object.fromEntries(PULSE_SOURCES.map(s => [s, { loading: false, error: false }]))
  const result = evaluatePulse({
    sources: { activities: PROGRAMME, programmeBaselines: headers, programmeBaselineSnapshot: snapshot },
    sourceStates, now: NOW, currencyCode: 'AUD',
  })
  return result.indicators.find(i => i.id === INDICATOR.BASELINE_SLIPPAGE)
}

// ── A. Print mounting ────────────────────────────────────────────────────────

describe('print: mounted synchronously before the browser captures the layout, removed afterwards', () => {
  const hook = stripComments(read('hooks/usePrintMoment.jsx'))
  const page = stripComments(read('pages/project/ProjectTimeline.jsx'))

  it('flushSync comes from react-dom — the supported synchronous flush, no print framework', () => {
    expect(hook).toContain("import { flushSync } from 'react-dom'")
    expect(hook).not.toMatch(/react-to-print|jspdf|html2canvas|pdfmake|setTimeout|requestAnimationFrame|queueMicrotask/)
    const pkg = readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8')
    expect(pkg).not.toMatch(/react-to-print|jspdf|html2canvas|pdfmake/)
  })

  it('the browser\'s own Print: the mount inside `beforeprint` is a flushSync, never an ordinary update', () => {
    expect(hook).toContain('const before = () => flushSync(() => setPrintAt(new Date()))')
    expect(hook).toContain("window.addEventListener('beforeprint', before)")
    // Every state change that MOUNTS the report is inside flushSync.
    const mounts = hook.match(/setPrintAt\(new Date\(\)\)/g)
    expect(mounts).toHaveLength(2)
    expect(hook.match(/flushSync\(\(\) => setPrintAt\(new Date\(\)\)\)/g)).toHaveLength(2)
  })

  it('the Print button: mounted synchronously BEFORE window.print() is called', () => {
    const print = hook.slice(hook.indexOf('const print = useCallback('))
    const flush = print.indexOf('flushSync(() => setPrintAt(new Date()))')
    const call = print.indexOf('window.print()')
    expect(flush).toBeGreaterThan(-1)
    expect(call).toBeGreaterThan(flush)
    expect(hook.match(/window\.print\(\)/g)).toHaveLength(1)
  })

  it('cleanup: `afterprint` unmounts, and both listeners are removed with the page', () => {
    expect(hook).toContain('const after = () => setPrintAt(null)')
    expect(hook).toContain("window.addEventListener('afterprint', after)")
    expect(hook).toContain("window.removeEventListener('beforeprint', before)")
    expect(hook).toContain("window.removeEventListener('afterprint', after)")
    // Registered once for the life of the page — no dependency that could
    // re-register between a beforeprint and its afterprint.
    expect(hook).toMatch(/\}, \[\]\)/)
  })

  it('the hook reads and writes no data', () => {
    expect(hook).not.toMatch(/firebase|firestore|localStorage|sessionStorage|fetch\(|setDoc|updateDoc|runTransaction/)
  })

  it('the page mounts the report from the hook\'s moment and has no print state of its own', () => {
    expect(page).toContain('const { printAt, print } = usePrintMoment()')
    expect(page).toContain('{printable && <ProgrammeReport report={report} generatedAt={printAt} />}')
    expect(page).not.toMatch(/setPrintAt|flushSync|window\.print|beforeprint|afterprint/)
    const handler = page.slice(page.indexOf('function handlePrint()'), page.indexOf('const setScale = '))
    expect(handler).toContain('print()')
    expect(handler).not.toMatch(/await|setTimeout|then\(/)
  })

  it('what is printed is the CURRENT report model: the displayed set, its filters and the selected baseline', () => {
    // One memo, recomputed from the live filter and baseline state; the print
    // receives that object — there is no copy taken earlier that could go stale.
    expect(page).toMatch(/const report = useMemo\(\(\) => buildProgrammeReport\(\{/)
    expect(page).toMatch(/activities: ordered, shown: filtered, depStates, attention,/)
    expect(page).toContain('baseline: baselineInfo, comparison,')
    expect(page).toContain('search, status, hideClosed, due, attention: attentionFilter,')
    for (const dep of ['filtered', 'attention', 'baselineInfo', 'comparison', 'attentionFilter', 'search', 'status', 'hideClosed', 'due', 'responsible']) {
      expect(page.slice(page.indexOf('const report = useMemo('), page.indexOf('const exportable = ')), dep).toContain(dep)
    }
    expect(page.match(/<ProgrammeReport /g)).toHaveLength(1)
  })

  it('L2-A and L2-C prints are untouched: their pages do not use the hook and their print rules are unchanged', () => {
    for (const rel of ['pages/project/ProjectReports.jsx', 'pages/PortfolioReport.jsx', 'pages/project/ProjectFinalAccount.jsx']) {
      const src = stripComments(read(rel))
      expect(src, rel).not.toContain('usePrintMoment')
      expect(src, rel).not.toContain('programme-report')
    }
    expect(stripComments(read('pages/project/ProjectReports.jsx'))).toContain('flushSync(() => setGeneratedAt(new Date()))')
    expect(stripComments(read('pages/PortfolioReport.jsx'))).toContain('flushSync(() => setGeneratedAt(new Date()))')
    // The programme report is display:none outside print, and is absent from
    // the DOM altogether unless a print is in progress.
    const css = read('index.css')
    expect(css).toMatch(/^\.commercial-report\.programme-report \{ display: none; \}$/m)
  })
})

describe('print content follows the current filter and the selected baseline (the model the print renders)', () => {
  it('a filter narrows the printed rows and is named in the scope line', () => {
    const { report } = pageState({ filter: ATTENTION_FLAG.BLOCKED })
    expect(report.rows.map(r => r.id)).toEqual(['footings'])
    expect(report.scope.text).toBe('Filtered programme — 1 of 4 activities (Attention: Blocked)')
  })

  it('changing the selected baseline changes the printed label, basis and variances together', () => {
    const active = pageState({ choice: 'active' }).report
    const historical = pageState({ choice: 'b1' }).report
    expect(active.baseline.label).toBe('Baseline 2 — Contract programme')
    expect(historical.baseline.label).toBe('Baseline 1 — Tender programme')
    const finish = (r, id) => r.rows.find(x => x.id === id).baseline.finishVariance
    expect([finish(active, 'frame'), finish(active, 'handover')]).toEqual([0, 5])
    expect([finish(historical, 'frame'), finish(historical, 'handover')]).toEqual([5, 26])
  })

  it('the printed component renders the model\'s scope, baseline text and basis text — nothing of its own', () => {
    const component = stripComments(read('pages/project/timeline/ProgrammeReport.jsx'))
    expect(component).toContain('{report.scope.text}')
    expect(component).toContain('{b.text}')
    expect(component).toContain('{b.basisText && ')
  })
})

// ── B. Baseline integrity ────────────────────────────────────────────────────

describe('one integrity check for PULSE (active) and GANTT (selected)', () => {
  it('baselineSnapshotProblem is what resolveActiveBaseline returns, case by case', () => {
    const cases = [
      SNAP2, null, { ...SNAP2, id: 'b1' }, { id: 'b2', activityCount: 'x', activities: SNAP2.activities },
      { id: 'b2', activityCount: 4, activities: 'junk' }, { ...SNAP2, activityCount: 3 },
    ]
    expect(cases.map(s => baselineSnapshotProblem(B2, s))).toEqual([
      null, BASELINE_PROBLEM.NO_SNAPSHOT, BASELINE_PROBLEM.WRONG_VERSION, BASELINE_PROBLEM.MALFORMED,
      BASELINE_PROBLEM.MALFORMED, BASELINE_PROBLEM.COUNT_MISMATCH,
    ])
    for (const s of cases) {
      expect(resolveActiveBaseline(HEADERS, s).problem).toBe(baselineSnapshotProblem(B2, s))
      expect(resolveActiveBaseline(HEADERS, s).usable).toBe(baselineSnapshotProblem(B2, s) === null)
    }
    expect(baselineSnapshotProblem(null, SNAP2)).toBeNull()
  })

  it('GANTT availability gives the same verdict for the same pair, with PULSE\'s own reason', () => {
    for (const s of [null, { ...SNAP2, id: 'b1' }, { id: 'b2', activityCount: 'x', activities: [] }, { ...SNAP2, activityCount: 3 }]) {
      const a = baselineAvailability({ headers: HEADERS, header: B2, label: 'Baseline 2 — Contract programme', snapshot: s })
      const p = resolveActiveBaseline(HEADERS, s)
      expect(a.available).toBe(p.usable)
      expect(a.state).toBe(BASELINE_AVAILABILITY.UNUSABLE)
      expect(a.problem).toBe(p.problem)
      expect(a.text).toContain(BASELINE_PROBLEM_TEXT[p.problem])
      expect(a.text).toContain('not zero')
      expect(a.basisText).toBe('')
    }
  })

  it('the check is defined once: GANTT imports it, and neither GANTT module re-states it', () => {
    const report = stripComments(read('lib/programmeReport.js'))
    expect(report).toContain("import { approvedOnIso, baselineSnapshotProblem, BASELINE_PROBLEM_TEXT } from './pulseSchedule'")
    expect(report).toContain('problem = baselineSnapshotProblem(header, snapshot)')
    expect(report).not.toMatch(/isSnapshotUsable|activityCount/)
    expect(stripComments(read('lib/programmeAttention.js'))).not.toMatch(/isSnapshotUsable|activityCount|baselineSnapshotProblem/)
    const pulse = stripComments(read('lib/pulseSchedule.js'))
    expect(pulse.match(/snapshot\.activityCount !== header\.activityCount/g)).toHaveLength(1)
    expect(pulse).toContain('const problem = baselineSnapshotProblem(header, snapshot)')
  })

  it('the page has ONE usability answer — chart, list, summary, flag and report all follow it', () => {
    const page = stripComments(read('pages/project/ProjectTimeline.jsx'))
    expect(page).toContain('const baselineUsable = baselineInfo.available')
    expect(page).not.toContain('isSnapshotUsable')
    expect(page).toContain('const comparison = useMemo(() => (baselineUsable ? baselineComparison(ordered, snapshot) : null), [baselineUsable, ordered, snapshot])')
    expect(page).toContain('const baselineSummaryValue = useMemo(() => (baselineUsable ? baselineSummary(ordered, snapshot) : null), [baselineUsable, ordered, snapshot])')
    expect(page).toContain('baseline: { usable: baselineInfo.available, header: selectedHeader, comparison },')
    expect(page).toContain("integrityText={baselineInfo.problem ? baselineInfo.text : ''}")
  })
})

describe('an invalid or incomplete baseline is suppressed everywhere — never a fabricated figure', () => {
  // The snapshot lost an entry: header says 4, snapshot holds 3. Compared
  // naively, the missing activity would read as "added after" and the rest
  // would still show day figures.
  const INCOMPLETE = snapshotOf('b2', SNAP2.activities.slice(0, 3))
  const BAD = [
    ['header / snapshot count mismatch', INCOMPLETE, BASELINE_PROBLEM.COUNT_MISMATCH],
    ['count field edited to disagree with the header', { ...SNAP2, activityCount: 9 }, BASELINE_PROBLEM.COUNT_MISMATCH],
    ['snapshot document missing', null, BASELINE_PROBLEM.NO_SNAPSHOT],
    ['another version\'s snapshot', SNAP1, BASELINE_PROBLEM.WRONG_VERSION],
    ['malformed snapshot', { id: 'b2', activityCount: 4, activities: 'junk' }, BASELINE_PROBLEM.MALFORMED],
  ]

  it.each(BAD)('%s: no comparison, flag not evaluated, no variance on any row', (_name, snapshot, problem) => {
    const { baseline, comparison, attention, report } = pageState({ snapshot })
    expect(baseline).toMatchObject({ available: false, state: BASELINE_AVAILABILITY.UNUSABLE, problem })
    expect(comparison).toBeNull()
    expect(attention.baselineEvaluated).toBe(false)
    expect(attention.counts.laterThanBaseline).toBeNull()
    for (const r of report.rows) {
      expect(r.baseline).toMatchObject({ state: BASELINE_ROW_STATE.NO_BASELINE, start: null, finish: null, startVariance: null, finishVariance: null, text: '' })
      expect(r.flags.laterThanBaseline).toBe(false)
    }
    expect(filterByAttention(PROGRAMME, attention, ATTENTION_FLAG.LATER_THAN_BASELINE)).toEqual([])
  })

  it.each(BAD)('%s: the CSV says UNAVAILABLE / NOT EVALUATED and carries the reason — no 0 and no blank', (_name, snapshot, problem) => {
    const { report } = pageState({ snapshot })
    const text = programmeReportCsv(report, { generatedAt: GENERATED })
    const M = PROGRAMME_CSV_MARKER
    const line = (label) => text.split('\r\n').find(l => l.startsWith(`"${label}"`))
    expect(line('Baseline')).toContain(`"${M.UNAVAILABLE}"`)
    expect(line('Baseline')).toContain(BASELINE_PROBLEM_TEXT[problem])
    expect(line('Baseline approved')).toBe(`"Baseline approved","${M.UNAVAILABLE}"`)
    expect(line('Baseline basis')).toBe(`"Baseline basis","${M.NOT_EVALUATED}",""`)
    expect(line('Later than baseline')).toBe(`"Later than baseline","${M.NOT_EVALUATED}"`)
    const row = line('excavation')
    expect(row.endsWith(`"${M.NOT_EVALUATED}","${M.UNAVAILABLE}","${M.UNAVAILABLE}","${M.UNAVAILABLE}","${M.UNAVAILABLE}","${report.baseline.text.replace(/"/g, '""')}"`)).toBe(true)
  })

  it('PULSE refuses the same incomplete baseline: neither side reports a figure', () => {
    const pulse = pulseOf(INCOMPLETE)
    expect(pulse.state).toBe(PULSE_STATE.NEEDS_DATA)
    expect(pulse.values.later).toBeUndefined()
    expect(pageState({ snapshot: INCOMPLETE }).attention.counts.laterThanBaseline).toBeNull()
  })

  it('the trap this closes: the incomplete snapshot WOULD produce plausible-looking variance if compared', () => {
    const naive = baselineComparison(PROGRAMME, INCOMPLETE)
    expect(naive.get('handover').kind).toBe('added_after')   // it was in the approved baseline
    expect(naive.get('frame').finishVariance).toBe(0)
  })

  it('the current-plan flags are unaffected by a bad baseline', () => {
    const good = pageState().attention.counts
    const bad = pageState({ snapshot: INCOMPLETE }).attention.counts
    for (const k of ['overdue', 'blocked', 'conflict', 'review', 'total']) expect(bad[k]).toBe(good[k])
  })

  it('a legacy header with no integer count is still comparable, exactly as in PULSE', () => {
    const legacy = [{ ...B1 }, { id: 'b2', name: 'Contract programme', status: 'approved', approvedAt: B2.approvedAt }]
    expect(resolveActiveBaseline(legacy, SNAP2).usable).toBe(true)
    expect(pageState({ headers: legacy }).baseline.available).toBe(true)
  })
})

describe('the same valid baseline: GANTT and PULSE agree', () => {
  it('active baseline selected → the flag count is the PULSE indicator\'s count, and the same activities', () => {
    const { attention, baseline } = pageState({ choice: 'active' })
    const pulse = pulseOf(SNAP2)
    expect(pulse.state).toBe(PULSE_STATE.FINDING)
    expect(attention.counts.laterThanBaseline).toBe(pulse.values.later)
    expect(pulse.evidence.map(r => r.id).sort()).toEqual([...attention.byId.entries()].filter(([, f]) => f.laterThanBaseline).map(([id]) => id).sort())
    expect(baseline).toMatchObject({ isActive: true, available: true })
    expect(baseline.basisText).toBe('This is the active approved baseline — the version Constrap PULSE™ measures against.')
  })

  it('choosing the active version by its id is the same as "active"', () => {
    const byId = pageState({ choice: 'b2' })
    expect(byId.baseline.isActive).toBe(true)
    expect(byId.attention.counts).toEqual(pageState({ choice: 'active' }).attention.counts)
  })
})

describe('a historical selected baseline: still compared, and the difference from PULSE is stated', () => {
  const historical = pageState({ choice: 'b1' })

  it('a valid historical version is preserved as a comparison', () => {
    expect(activeBaseline(HEADERS).id).toBe('b2')
    expect(historical.baseline).toMatchObject({ available: true, isActive: false, activeLabel: 'Baseline 2 — Contract programme', problem: null })
    expect(historical.attention.counts.laterThanBaseline).toBe(2)
    // PULSE, on the active version, counts 1 — the two legitimately differ.
    expect(pulseOf(SNAP2).values.later).toBe(1)
  })

  it('the interface and the exports say so', () => {
    const expected = 'This is a historical approved baseline, not the active one (Baseline 2 — Contract programme). Constrap PULSE™ measures against the active baseline, so its later-than-baseline count can differ from the one here.'
    expect(historical.baseline.basisText).toBe(expected)
    const text = programmeReportCsv(historical.report, { generatedAt: GENERATED })
    expect(text).toContain(`"Baseline basis","HISTORICAL","${expected}"`)
    expect(programmeReportCsv(pageState().report, { generatedAt: GENERATED })).toContain('"Baseline basis","ACTIVE",')
    const chips = stripComments(read('pages/project/timeline/AttentionFilter.jsx'))
    expect(chips).toContain('{attention?.baselineEvaluated && baseline?.isActive === false && (')
    expect(chips).toContain('{baseline.basisText}')
    expect(stripComments(read('pages/project/timeline/ProgrammeReport.jsx'))).toContain('{b.basisText && ')
  })

  it('without the header list the basis is unknown — nothing is claimed', () => {
    const a = baselineAvailability({ header: B1, label: 'Baseline 1 — Tender programme', snapshot: SNAP1 })
    expect(a).toMatchObject({ available: true, isActive: null, basisText: '' })
    const report = buildProgrammeReport({ activities: PROGRAMME, shown: PROGRAMME, baseline: a, comparison: baselineComparison(PROGRAMME, SNAP1) })
    expect(programmeReportCsv(report, { generatedAt: GENERATED })).toContain(`"Baseline basis","${PROGRAMME_CSV_MARKER.UNAVAILABLE}",""`)
  })
})

describe('Hide baseline is presentation only', () => {
  const page = stripComments(read('pages/project/ProjectTimeline.jsx'))

  it('`baselineShown` reaches only the visual baseline view — never availability, attention, the report or the comparison', () => {
    const uses = page.match(/baselineShown/g)
    // state declaration, the view memo (value + dependency), the panel prop.
    expect(uses).toHaveLength(4)
    expect(page).toContain('shown: baselineShown && baselineUsable,')
    for (const [from, to] of [
      ['const baselineInfo = useMemo(', 'const baselineUsable = '],
      ['const attention = useMemo(', 'const filtered = useMemo('],
      ['const report = useMemo(', 'const exportable = '],
    ]) {
      expect(page.slice(page.indexOf(from), page.indexOf(to)), from).not.toMatch(/baselineShown|baselineView/)
    }
    expect(page).not.toMatch(/baselineComparison\([^)]*baselineShown/)
  })
})

describe('nothing is mutated and nothing is stored', () => {
  const deepFreeze = (o) => {
    if (o && typeof o === 'object' && !Object.isFrozen(o) && !(o instanceof Map)) {
      Object.freeze(o)
      for (const v of Object.values(o)) if (typeof v !== 'function') deepFreeze(v)
    }
    return o
  }

  it('availability, attention and the report leave activities, headers and snapshots untouched — valid or invalid', () => {
    const plain = (o) => JSON.parse(JSON.stringify(o))
    const activities = deepFreeze(plain(PROGRAMME))
    const headers = deepFreeze(plain(HEADERS))
    for (const snapshot of [deepFreeze(plain(SNAP2)), deepFreeze(plain({ ...SNAP2, activityCount: 9 }))]) {
      const before = JSON.stringify([activities, headers, snapshot])
      const baseline = baselineAvailability({ headers, header: headers[1], label: 'Baseline 2', snapshot })
      const comparison = baseline.available ? baselineComparison(activities, snapshot) : null
      const depStates = dependencyStates(activities, NOW)
      const attention = buildProgrammeAttention({ activities, depStates, now: NOW, baseline: { usable: baseline.available, header: headers[1], comparison } })
      const report = buildProgrammeReport({ activities, shown: activities, depStates, attention, baseline, comparison })
      programmeReportCsv(report, { generatedAt: GENERATED })
      expect(JSON.stringify([activities, headers, snapshot])).toBe(before)
    }
  })

  it('no baseline document is written or changed by these corrections', () => {
    const hooks = stripComments(read('hooks/useProgrammeBaselines.jsx')) + stripComments(read('hooks/useProgrammeBaselineSnapshot.jsx'))
    expect(hooks).not.toMatch(/baselineSnapshotProblem|baselineAvailability|usePrintMoment/)
    expect(stripComments(read('hooks/useProgrammeBaselineSnapshot.jsx'))).not.toMatch(/setDoc|updateDoc|deleteDoc|runTransaction/)
  })
})
