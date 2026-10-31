import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// ── Constrapp GANTT™ 1A1 — surface pins (ADR-64) ─────────────────────────────
//
// Source-level pins in the Node-only runner (no jsdom), the betaSurfaces /
// moduleBranding idiom: the chart is one scroller with sticky labels and
// header, every bar is a real button with a descriptive name, activating a bar
// opens the EXISTING editor (author) or a genuinely read-only detail (reader),
// the dialogs share the accessible shell, the chart and the list are two views
// of ONE filtered set over ONE subscription, and nothing here writes, drags,
// reschedules or installs anything.

const read = (rel) =>
  readFileSync(fileURLToPath(new URL(`../../src/${rel}`, import.meta.url)), 'utf8')
const readRoot = (rel) =>
  readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8')
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '')

const page    = stripComments(read('pages/project/ProjectTimeline.jsx'))
const chart   = stripComments(read('pages/project/timeline/TimelineGantt.jsx'))
const dialog  = stripComments(read('pages/project/timeline/ActivityDialog.jsx'))
const detail  = stripComments(read('pages/project/timeline/ActivityDetailModal.jsx'))
const editor  = stripComments(read('pages/project/timeline/ActivityEditorModal.jsx'))
const cancel  = stripComments(read('pages/project/timeline/ActivityCancelModal.jsx'))
const table   = stripComments(read('pages/project/timeline/ActivityTable.jsx'))
const cards   = stripComments(read('pages/project/timeline/ActivityCards.jsx'))
const panel   = stripComments(read('pages/dashboard/ProgrammePanel.jsx'))
const pulse   = stripComments(read('lib/pulse.js'))
const hook    = stripComments(read('hooks/useProjectActivities.jsx'))
const geometry = stripComments(read('lib/timelineGantt.js'))
const grouping = stripComments(read('lib/ganttGrouping.js'))

describe('one scroller, sticky labels and header, both axes', () => {
  it('the chart scrolls inside one container and keeps its labels and dates in view', () => {
    expect(chart).toContain('ref={scrollerRef} className="overflow-auto max-h-[70vh]"')
    expect(chart.match(/sticky left-0/g).length).toBeGreaterThanOrEqual(3) // header corner, group cell, bar cell
    expect(chart).toContain('sticky top-0 z-20')
    expect(chart).toContain('sticky left-0 z-30')
  })

  it('zoom is a pressed-state button group; grouping a labelled select; Today a real button disabled off-window', () => {
    expect(chart).toContain('role="group" aria-label="Zoom"')
    expect(chart).toContain('aria-pressed={scale === s}')
    expect(chart).toContain('aria-label="Group activities by"')
    expect(chart).toContain('onClick={scrollToToday}')
    expect(chart).toContain('disabled={model.todayX === null}')
    expect(chart).toContain('todayScrollLeft({ todayX, canvasWidth, viewportWidth: el.clientWidth })')
  })

  it('day ticks render only at day zoom, week labels at week zoom, months always', () => {
    expect(chart).toContain("model.scale === GANTT_SCALE.DAY ? model.days : model.scale === GANTT_SCALE.WEEK ? model.weeks : []")
    expect(chart).toContain('{model.months.map(m => (')
  })

  it('the chart stays hidden below md: the cards remain the phone programme', () => {
    const chartCard = page.slice(page.indexOf('view === VIEW.CHART && ('), page.indexOf('<TimelineGantt'))
    expect(chartCard).toContain('hidden md:block')
    expect(page).toContain('<div className="md:hidden mb-3.5">')
    expect(page).toContain('<ActivityCards')
  })
})

describe('bars are keyboard-reachable buttons with descriptive names — no nested controls', () => {
  it('every planned bar and milestone is a <button type="button"> with aria-label and a focus ring', () => {
    const rowSrc = chart.slice(chart.indexOf('function GanttBarRow'))
    expect(rowSrc.match(/<button\s+type="button"/g)).toHaveLength(2) // milestone, bar
    expect(rowSrc.match(/aria-label=\{name\}/g)).toHaveLength(2)
    expect(rowSrc.match(/focus-visible:outline-2 focus-visible:outline-brand-accent/g).length).toBeGreaterThanOrEqual(2)
    expect(rowSrc).toContain('onClick={() => onActivate?.(bar.id)}')
    // Inside a button only decorative spans — never another control.
    const barBtn = rowSrc.slice(rowSrc.lastIndexOf('<button') + '<button'.length, rowSrc.lastIndexOf('</button>'))
    expect(barBtn).not.toMatch(/<button|<a |<input|<select/)
    expect(barBtn).toContain('aria-hidden="true"')
  })

  it('the accessible name carries activity, status, progress, planned dates, recorded dates, comparison and overdue', () => {
    const nameFn = chart.slice(chart.indexOf('function barName'), chart.indexOf('export default function TimelineGantt'))
    expect(nameFn).toContain('${bar.name} — ${bar.statusLabel}, ${bar.percentComplete}% complete.')
    expect(nameFn).toContain('Planned ${formatIsoDate(bar.plannedStart)} to ${formatIsoDate(bar.plannedFinish)}')
    expect(nameFn).toContain('actualSentence(bar)')
    expect(nameFn).toContain('bar.planComparison')
    expect(nameFn).toContain("bar.isOverdue ? ' Overdue.' : ''")
    expect(nameFn).toContain("' Opens the editor.' : ' Opens the details.'")
  })

  it('group headers are buttons with aria-expanded and carry their counts even when collapsed', () => {
    expect(chart).toContain('aria-expanded={!row.collapsed}')
    expect(chart).toContain('onClick={() => onToggleGroup?.(row.key)}')
    expect(chart).toContain('{row.overdueCount > 0 && <span className="text-brand-red font-bold"> · {row.overdueCount} overdue</span>}')
  })

  it('the recorded-dates overlay is decorative — its facts live in the button name', () => {
    const overlay = chart.slice(chart.indexOf('{actual && ('), chart.lastIndexOf('</div>'))
    expect(overlay).toContain('aria-hidden="true"')
    expect(overlay).not.toMatch(/<button|onClick/)
  })

  it('nothing drags, resizes or reschedules', () => {
    for (const src of [chart, page, geometry, grouping]) {
      expect(src).not.toMatch(/onDrag|draggable|onPointerMove|onMouseMove|onTouchMove|resize|reschedul\w*\(/i)
    }
    expect(chart).toContain('there is no drag-to-reschedule')
  })
})

describe('activation: the existing editor for an author, a read-only detail for a reader', () => {
  it('the page resolves the record from the loaded programme and routes by role and lifecycle', () => {
    const handler = page.slice(page.indexOf('function handleActivate'), page.indexOf('async function handleQuickAction'))
    expect(handler).toContain('const activity = ordered.find(a => a.id === activityId)')
    expect(handler).toContain('if (canWrite && activity.status !== ACTIVITY_STATUS.CANCELLED) setEditing(activity)')
    expect(handler).toContain('else setViewing(activity)')
    expect(page).toContain('onActivate={handleActivate}')
    expect(page).toContain('canWrite={canWrite}')
  })

  it('the read-only detail has no form, no Save, no quick action and no write import', () => {
    expect(detail).not.toMatch(/<form|type="submit"|Save|onSave|onQuickAction|updateActivity|createActivity|cancelActivity|setDoc|updateDoc|runTransaction/)
    expect(detail).toContain('<Btn variant="ghost" type="button" onClick={onClose}>Close</Btn>')
    expect(detail).toContain('Read-only. Company admins and project managers author the programme.')
    expect(detail).toContain('Constrapp stores no baseline')
    expect(detail).toContain('Entered by hand, unverified')
    expect(detail).toContain("import { planComparisonLabel } from '../../../lib/timelineGantt'")
    expect(detail).not.toMatch(/from 'firebase|from '\.\.\/\.\.\/\.\.\/hooks\//)
  })

  it('the detail is mounted only for `viewing`, the editor only for `editing`', () => {
    expect(page).toContain('{viewing && (')
    expect(page).toContain('<ActivityDetailModal')
    expect(page).toContain('onClose={() => setViewing(null)}')
    expect(page).toContain('{editing && (')
    expect(page).toContain('<ActivityEditorModal')
  })
})

describe('the accessible dialog shell, shared by editor, cancel and detail', () => {
  it('ActivityDialog packages the QuantDialog contract: role, aria-modal, labelled title, Tab containment, Escape, focus return', () => {
    expect(dialog).toContain('role="dialog" aria-modal="true" aria-labelledby={titleId}')
    expect(dialog).toContain("import { tabbableWithin, tabTarget } from '../../../lib/dialogFocus'")
    expect(dialog).toContain("if (e.key === 'Escape')")
    expect(dialog).toContain('if (busy) return')
    expect(dialog).toContain('const opener = document.activeElement')
    expect(dialog).toContain('return () => { if (opener && typeof opener.focus === \'function\') opener.focus() }')
    expect(dialog).toContain('if (panel && !panel.contains(document.activeElement)) panel.focus()')
    expect(dialog).toContain('onClick={busy ? undefined : onClose}')
    expect(dialog).toContain('disabled={busy}')
    expect(dialog).toContain('tabIndex={-1}')
    expect(dialog).not.toMatch(/from 'firebase|setInterval|setTimeout/)
  })

  it('the editor, the cancel dialog and the detail all render through it, with autoFocus on the first field', () => {
    expect(editor).toContain("import ActivityDialog from './ActivityDialog'")
    expect(editor).toContain('<ActivityDialog title={creating ? \'Add activity\' : \'Edit activity\'} titleId="activity-editor-title" onClose={onClose} busy={saving}>')
    expect(editor).toContain('autoFocus')
    expect(editor).not.toContain('function ModalShell')
    expect(cancel).toContain('<ActivityDialog title="Cancel activity" titleId="activity-cancel-title" onClose={onClose} busy={saving} panelClassName="max-w-[520px]">')
    expect(cancel).toContain('autoFocus')
    expect(detail).toContain('<ActivityDialog title="Activity" titleId="activity-detail-title" onClose={onClose} panelClassName="max-w-[560px]">')
    // No dialog opens its own overlay any more.
    for (const src of [editor, cancel, detail]) expect(src).not.toContain('fixed inset-0 z-50')
  })

  it('the editor\'s validation and save path are unchanged (ADR-65: the save is guarded against `base`)', () => {
    expect(editor).toContain('const validationError = validateActivityDraft(fields, { creating })')
    expect(editor).toContain('await onSave({ ...fields, predecessors: toStoredPredecessors(storedPredecessors) }, base)')
    expect(editor).toContain("if (!prev.actualStart) next.actualStart = today")
    expect(cancel).toContain('const reasonError = validateCancelReason(reason)')
    expect(cancel).toContain('await onCancelActivity(activity, reason)')
  })
})

describe('chart and list are two views of ONE filtered set over ONE subscription', () => {
  it('a Chart / List pressed-state toggle above md; both read `filtered`; the table is still the record', () => {
    expect(page).toContain('role="group" aria-label="Programme view" className="hidden md:flex')
    expect(page).toContain('aria-pressed={view === VIEW.CHART}')
    expect(page).toContain('aria-pressed={view === VIEW.LIST}')
    expect(page).toContain('{view === VIEW.CHART && (')
    expect(page).toContain('{view === VIEW.LIST && (')
    expect(page).toContain('<ActivityTable')
    expect(page).toContain('The complete record — every figure on the chart is read from here.')
  })

  it('the summary cards are computed over the whole programme, not the filtered or collapsed view', () => {
    expect(page).toContain('const summary  = useMemo(() => timelineSummary(ordered, now), [ordered, now])')
  })

  it('zoom, grouping and collapse are page state only — nothing is stored', () => {
    expect(page).toContain('const [scale, setScaleState]  = useState(DEFAULT_GANTT_SCALE)')
    expect(page).toContain('const [groupBy, setGroupByState] = useState(GANTT_GROUP.NONE)')
    expect(page).toContain('const [collapsed, setCollapsed]  = useState(() => new Set())')
    expect(page).not.toMatch(/localStorage|sessionStorage|setDoc|updateDoc/)
    expect(hook).not.toMatch(/scale|groupBy|collapsed|zoom/)
  })

  it('the hook keeps its one subscription; the domain carries no speculative field (predecessors is the ADR-65 field)', () => {
    expect(hook).toContain("const q = query(ref, orderBy('createdAt', 'asc'))")
    expect(hook.match(/onSnapshot\(/g)).toHaveLength(1)
    // ADR-65: no unconditioned write remains in the hook.
    expect(hook).not.toMatch(/\bupdateDoc\(|\bsetDoc\(/)
    expect(hook).toContain('runActivityUpdate({')
    expect(hook).toContain('runActivityCancel({')
    expect(hook).toContain('runActivityCreate({')
    const domain = stripComments(read('lib/projectTimeline.js'))
    expect(domain).toContain('export function normaliseActivityDraft')
    expect(domain).not.toMatch(/baseline(Start|Finish)|successors|scale|groupBy|critical/)
  })

  it('geometry and grouping are pure: no React, no Firebase, no clock of their own', () => {
    for (const src of [geometry, grouping]) {
      // (`window` in lib/timelineGantt.js is the DATE window, never the DOM.)
      expect(src).not.toMatch(/from 'react|from 'firebase|onSnapshot|document\.|globalThis|localStorage/)
      // The only clock is the injected `now = new Date()` default parameter;
      // `new Date(Date.UTC(…))` is calendar arithmetic, not a clock.
      expect(src.replace(/now = new Date\(\)/g, '').replace(/new Date\(Date\.UTC\(/g, '')).not.toMatch(/new Date\(/)
    }
  })
})

describe('existing links, labels and tokens', () => {
  it('the Dashboard panel and PULSE indicator 4 still link to the timeline route, now labelled GANTT', () => {
    expect(panel).toContain('to={`/projects/${projectId}/timeline`}')
    expect(panel).toContain('Open GANTT →')
    expect(pulse).toContain("[INDICATOR.OVERDUE_ACTIVITIES]:         { to: 'timeline',                    label: 'Open GANTT' }")
  })

  it('the chart uses tokens only — no hex, and every status colour is the existing one', () => {
    expect(chart).not.toMatch(/#[0-9a-fA-F]{3,6}\b/)
    expect(chart).toContain("const ACTUAL_COLOUR = 'var(--color-brand-text-soft)'")
    expect(table).not.toContain('brand-gantt')
    expect(cards).not.toContain('brand-gantt')
  })

  it('the ADR-64 wording survives: current plan, calendar days, no critical path', () => {
    expect(chart).toContain('Comparisons are against the current plan, not a baseline.')
    expect(chart).toContain('a dependency is shown, never enforced by moving a date, and Constrapp has no\n        critical path')
    expect(page).toContain('Current plan, not an approved baseline.')
  })

  it('no new runtime dependency', () => {
    const pkg = JSON.parse(readRoot('package.json'))
    expect(Object.keys(pkg.dependencies).sort()).toEqual([
      '@tailwindcss/vite', 'firebase', 'pdfjs-dist', 'react', 'react-dom', 'react-router-dom', 'recharts', 'tailwindcss',
    ])
  })
})

// ── Programme 1A2 — dependencies and guarded writes (ADR-65) ─────────────────

describe('ADR-65: dependencies on the chart, in the editor and in the detail', () => {
  const actions = stripComments(read('lib/activityActions.js'))
  const deps = stripComments(read('lib/ganttDependencies.js'))

  it('ONE SVG overlay behind the rows, pointer-events none and aria-hidden; arrows styled by state, never colour alone', () => {
    expect(chart.match(/<svg/g)).toHaveLength(1)
    const svg = chart.slice(chart.indexOf('<svg'), chart.indexOf('</svg>'))
    expect(svg).toContain('pointer-events-none')
    expect(svg).toContain('aria-hidden="true"')
    expect(svg).toContain('focusable="false"')
    expect(svg).toContain('arrowPath(a)')
    expect(chart).toContain("[DEPENDENCY_STATE.CONFLICT]:  { stroke: 'var(--color-brand-red)',    dash: '5 3' }")
    expect(chart).toContain('Finish-to-start dependency')
    expect(chart).toContain('Dependency conflict')
    expect(chart).toContain('Dependency requires review')
    expect(chart).not.toContain('brand-gantt')
  })

  it('hidden and truncated links are disclosed, with the detail named as the complete record', () => {
    expect(chart).toContain('links.hidden > 0 || links.truncated')
    expect(chart).toContain("still listed in each activity's details")
    expect(chart).toContain('MAX_ARROWS_DRAWN')
  })

  it('the bar name carries the dependency sentence and the label the Blocked / Conflict / Review flag', () => {
    expect(chart).toContain('const deps = dependencyLabel(depState)')
    expect(chart).toContain("(deps ? ` ${deps}` : '')")
    expect(chart).toContain("{flag ? `${flag} · ` : ''}")
    expect(chart).toContain('← {depState.count}')
    expect(table).toContain('dependencyFlag(dep)')
    expect(cards).toContain('dependencyFlag(dep)')
    expect(detail).toContain('<Row label="Predecessors">')
    expect(detail).toContain('<Row label="Successors">')
  })

  it('the editor: a predecessor fieldset, a disabled-with-reason picker, lag 0..365, the conflict acknowledgement, no drag', () => {
    expect(editor).toContain('<legend className={labelCls}>Predecessors (finish to start)</legend>')
    expect(editor).toContain('disabled={Boolean(c.reason)}')
    expect(editor).toContain('max={MAX_LAG_DAYS}')
    expect(editor).toContain('min="0"')
    expect(editor).toContain('conflictAcknowledgementKey(fields)')
    expect(editor).toContain('if (conflicts.length > 0 && !acknowledged)')
    expect(editor).toContain("setAckKey(e.target.checked ? currentAckKey : null)")
    expect(editor).toContain('validatePredecessorsDraft(toStoredPredecessors(storedPredecessors), {')
    expect(editor).toContain('previousIds,')
    expect(editor).toContain('dependency requires review. Remove it or replace it.')
    expect(editor).not.toMatch(/onDrag|draggable/)
  })

  it('stale handling: the draft stays, a conflict message shows, "Reload latest" re-seeds from the current record', () => {
    expect(editor).toContain('if (err?.kind === ACTIVITY_WRITE_ERROR.STALE) setStale(true)')
    expect(editor).toContain('function reloadLatest()')
    expect(editor).toContain('setBase(latest)')
    expect(editor).toContain('setF(seedFields(latest, activities))')
    expect(editor).toContain('Reload latest')
    expect(editor).toContain('onSave({ ...fields, predecessors: toStoredPredecessors(storedPredecessors) }, base)')
  })

  it('the action layer: reads before the write, compare-and-set on revision AND stamps, exactly one increment, new sources re-read', () => {
    expect(actions).toContain('if (!sameActivityVersion(seen, current)) return { kind: QUICK_ACTION_ERROR.STALE }')
    expect(actions).toContain('const revision = activityRevision(current) + 1')
    expect(actions.match(/const revision = activityRevision\(current\) \+ 1/g)).toHaveLength(2) // update, cancel
    expect(actions).toContain('await checkNewPredecessors(tx, predecessorRef, newPredecessorIds(fields.predecessors, previousIds), current.id)')
    expect(actions).toContain("if (!snap.exists()) return 'A predecessor is not in this project\\'s programme.'")
    expect(actions).not.toMatch(/from 'firebase/)
    expect(actions).toContain('revision: 1,') // create
    // The whole graph is never read in a transaction.
    expect(actions).not.toMatch(/findCycleMembers|wouldCreateCycle/)
  })

  it('the domain is pure, iterative on cycles, and treats cancelled / missing / malformed / cyclic links as unresolved', () => {
    expect(deps).not.toMatch(/from 'react|from 'firebase|onSnapshot|document\./)
    expect(deps).toContain('export function findCycleMembers')
    expect(deps).not.toMatch(/function\s+\w+\([^)]*\)\s*\{[^}]*\b\1\s*\(/) // no self-recursive helper
    expect(deps).toContain("MALFORMED: 'malformed'")
    expect(deps).toContain("CANCELLED: 'cancelled'")
    expect(deps).toContain('const finished = Boolean(predecessor) && predecessor.status === ACTIVITY_STATUS.COMPLETED\n        && !isUnresolvedState(state)')
    expect(deps).toContain('const startArrived = isValidIsoDate(a.plannedStart) && a.plannedStart <= today')
    expect(deps).toContain("MAX_LAG_DAYS = 365")
    expect(deps).toContain("MIN_LAG_DAYS = 0")
  })

  it('the page derives the states over the WHOLE programme with the one clock and hands them down', () => {
    expect(page).toContain('const depStates = useMemo(() => dependencyStates(ordered, now), [ordered, now])')
    expect(page).toContain('const succIndex = useMemo(() => successorIndex(ordered), [ordered])')
    expect(page.match(/dependencyStates=\{depStates\}/g)).toHaveLength(5) // chart, table, cards, editor, detail
    expect(page).toContain('successors={successorsOf(viewing.id, succIndex)}')
    expect(page).toContain('async function handleSave(fields, base)')
  })
})
