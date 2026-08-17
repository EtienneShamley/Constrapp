import { isIsoDateShape, todayIso } from './payments'

// ── Project Timeline — pure programme domain logic (ADR-29) ──────────────────
//
// Constrapp's programme is a CURRENT-PLAN schedule, not an approved-baseline
// variance report. There is no immutable baseline in V1, so every "late" figure
// here is measured against the planned dates AS THEY STAND NOW — editing a
// planned date silently redefines "on time". Never describe an output of this
// module as slippage against an approved programme.
//
// Everything in this file is PURE: no Firestore, no React, no clock. Anything
// date-relative takes an injected `now` (defaulting to `new Date()`) exactly as
// lib/payments.js, lib/clientInvoices.js and lib/cashFlow.js already do, so the
// unit suite can pin the calendar.
//
// ⚠️ THIS MODULE PERFORMS NO FINANCIAL ARITHMETIC AND READS NO FINANCIAL
// DOCUMENT. An activity carries an OPTIONAL cost code (the commercial spine) so
// a future read-time "delay → forecast impact" derivation has a join key — but
// the programme never writes Forecast, Cash Flow, Margin, Progress Claims, or
// `projects/{projectId}.progress`, and `percentComplete` never touches a
// financial figure. That separation is deliberate: programme progress is a
// manually authored, unverified assertion (see `percentComplete` below), and
// giving an unverifiable field financial consequence would create a second
// source of financial truth — the failure ADR-23/ADR-24 exist to prevent.

// ── Status ───────────────────────────────────────────────────────────────────
//
// Five states. `on_hold` deliberately replaces the more obvious `blocked`: a
// blocked activity is usually PART DONE, and forcing it into a status that
// implies no progress loses that. The reason for the hold lives in `notes`.
//
// ⚠️ DELIBERATELY NOT FORWARD-ONLY — a departure from ADR-11. Every FINANCIAL
// lifecycle in Constrapp is forward-only because those documents are an audit
// record. A programme is a PLAN: an activity ticked complete by mistake, or
// work reopened for a defect, must be correctable, or the first mis-click
// becomes a permanent lie. Only `cancelled` is terminal.
export const ACTIVITY_STATUS = {
  NOT_STARTED: 'not_started',
  IN_PROGRESS: 'in_progress',
  COMPLETED:   'completed',
  ON_HOLD:     'on_hold',
  CANCELLED:   'cancelled',
}

export const ACTIVITY_STATUS_ORDER = [
  ACTIVITY_STATUS.NOT_STARTED,
  ACTIVITY_STATUS.IN_PROGRESS,
  ACTIVITY_STATUS.ON_HOLD,
  ACTIVITY_STATUS.COMPLETED,
  ACTIVITY_STATUS.CANCELLED,
]

export const ACTIVITY_STATUS_LABELS = {
  [ACTIVITY_STATUS.NOT_STARTED]: 'Not started',
  [ACTIVITY_STATUS.IN_PROGRESS]: 'In progress',
  [ACTIVITY_STATUS.ON_HOLD]:     'On hold',
  [ACTIVITY_STATUS.COMPLETED]:   'Completed',
  [ACTIVITY_STATUS.CANCELLED]:   'Cancelled',
}

// Badge variants from the existing design system — NEVER a new colour value.
// Status is also always rendered as TEXT, so nothing is communicated by colour
// alone (see docs/DESIGN_SYSTEM.md and the accessibility note in ADR-26).
export const ACTIVITY_STATUS_BADGE = {
  [ACTIVITY_STATUS.NOT_STARTED]: 'soon',
  [ACTIVITY_STATUS.IN_PROGRESS]: 'info',
  [ACTIVITY_STATUS.ON_HOLD]:     'pending',
  [ACTIVITY_STATUS.COMPLETED]:   'active',
  [ACTIVITY_STATUS.CANCELLED]:   'danger',
}

// The two statuses that take an activity out of the programme's outstanding
// work. Used by overdue, grouping, and the summary cards.
export const CLOSED_STATUSES = [ACTIVITY_STATUS.COMPLETED, ACTIVITY_STATUS.CANCELLED]

export const isActivityStatus = (s) => ACTIVITY_STATUS_ORDER.includes(s)

export const isClosedStatus = (s) => CLOSED_STATUSES.includes(s)

// Open = still outstanding work on the programme (not completed, not cancelled).
export const isOpenStatus = (s) => isActivityStatus(s) && !isClosedStatus(s)

export const isTerminalStatus = (s) => s === ACTIVITY_STATUS.CANCELLED

// Statuses an activity may be CREATED in. `completed`/`on_hold` at creation are
// permitted too (back-entering an already-finished programme is a real need);
// `cancelled` is not — cancelling requires the dedicated lifecycle branch with
// its reason and audit stamps.
export const CREATABLE_STATUSES = [
  ACTIVITY_STATUS.NOT_STARTED,
  ACTIVITY_STATUS.IN_PROGRESS,
  ACTIVITY_STATUS.ON_HOLD,
  ACTIVITY_STATUS.COMPLETED,
]

export const isCreatableStatus = (s) => CREATABLE_STATUSES.includes(s)

// Transition legality. Any open state may move to any other open state or to
// `completed` — INCLUDING BACKWARDS (completed → in_progress), which is the
// whole point (see the note on ACTIVITY_STATUS). `cancelled` is terminal and is
// reached only through the cancellation branch, never through an ordinary edit.
export function canTransition(from, to) {
  if (!isActivityStatus(from) || !isActivityStatus(to)) return false
  if (from === ACTIVITY_STATUS.CANCELLED) return false
  if (to === ACTIVITY_STATUS.CANCELLED) return true
  return true
}

// True when the ordinary EDIT path may write this transition. Cancellation is
// excluded: it has its own branch in the hook and in firestore.rules.
export function canEditTransition(from, to) {
  return canTransition(from, to) && to !== ACTIVITY_STATUS.CANCELLED
}

// ── Roles ────────────────────────────────────────────────────────────────────
//
// ⚠️ THESE ARE UX HELPERS, NOT AUTHORISATION. Firestore Security Rules are the
// only trust boundary (docs/ENGINEERING_STANDARDS.md §7). These exist so the
// app hides actions a role cannot perform instead of showing a button that
// fails at the server — the `activities` rules block is what actually enforces
// the matrix below.
//
// The programme is the one place `qs` is NARROWER than the other internal
// roles: it READS (commercial context) but does not AUTHOR — programme
// authorship is operational PM/admin responsibility.
//
// `subcontractor` and `client` are absent from both lists deliberately: those
// roles are not scoped to their own projects, so any grant would expose every
// programme in the company (docs/SECURITY.md → Deferred Control 5/10).
// `super_admin` gains nothing here, matching every other collection.
export const PROGRAMME_READ_ROLES  = ['company_admin', 'project_manager', 'qs']
export const PROGRAMME_WRITE_ROLES = ['company_admin', 'project_manager']

export const canReadProgramme   = (role) => PROGRAMME_READ_ROLES.includes(role)
export const canAuthorProgramme = (role) => PROGRAMME_WRITE_ROLES.includes(role)

// ── Dates ────────────────────────────────────────────────────────────────────
//
// Programme dates are date-only 'YYYY-MM-DD' STRINGS — the convention already
// used by every human-entered date in the app (lib/payments.js → toIsoDate).
// A programme date is a day on a wall chart, not an instant; a Timestamp would
// attach timezone semantics to a fact that has none, and string comparison is
// both correct for zero-padded ISO and expressible in Firestore rules.
//
// ⚠️ THE FINISH DATE IS INCLUSIVE. A one-day activity has
// plannedStart == plannedFinish, so duration is (difference + 1) days.
//
// ⚠️ CALENDAR DAYS ONLY. Constrapp models no working calendar, no weekends and
// no public holidays. Every duration this module returns is calendar days and
// must be labelled as such in the UI.

const ISO_PARTS = /^(\d{4})-(\d{2})-(\d{2})$/

// Parses 'YYYY-MM-DD' to a UTC epoch, or null. UTC deliberately: a pure
// date-string difference must never be perturbed by the viewer's DST.
export function isoToUtcMs(iso) {
  if (typeof iso !== 'string') return null
  const m = ISO_PARTS.exec(iso)
  if (!m) return null
  const y = Number(m[1]); const mo = Number(m[2]); const d = Number(m[3])
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null
  const ms = Date.UTC(y, mo - 1, d)
  const back = new Date(ms)
  // Rejects impossible calendar dates that Date.UTC silently rolls over
  // (2026-02-30 → 2026-03-02).
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null
  return ms
}

// True for a well-formed, real calendar date.
export const isValidIsoDate = (iso) => isIsoDateShape(iso) && isoToUtcMs(iso) !== null

const DAY_MS = 86400000

// Whole days from `a` to `b` (positive when b is later). null on bad input.
export function daysBetween(a, b) {
  const from = isoToUtcMs(a)
  const to   = isoToUtcMs(b)
  if (from === null || to === null) return null
  return Math.round((to - from) / DAY_MS)
}

// 'YYYY-MM-DD' shifted by n days.
export function addDays(iso, n) {
  const ms = isoToUtcMs(iso)
  if (ms === null || !Number.isFinite(n)) return null
  return utcMsToIso(ms + Math.trunc(n) * DAY_MS)
}

const pad2 = (n) => String(n).padStart(2, '0')

export function utcMsToIso(ms) {
  const d = new Date(ms)
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`
}

// Calendar duration in days. A MILESTONE IS ZERO DAYS — it is a point in time,
// not a one-day activity. Returns null when the dates are unusable.
export function activityDuration(activity) {
  if (!activity) return null
  if (activity.isMilestone) return 0
  const diff = daysBetween(activity.plannedStart, activity.plannedFinish)
  if (diff === null || diff < 0) return null
  return diff + 1
}

// The same measure over the ACTUAL dates, once both exist.
export function actualDuration(activity) {
  if (!activity) return null
  if (activity.isMilestone) return activity.actualFinish ? 0 : null
  const diff = daysBetween(activity.actualStart, activity.actualFinish)
  if (diff === null || diff < 0) return null
  return diff + 1
}

// ── Derived programme state (never stored) ───────────────────────────────────
//
// ⚠️ `overdue` IS DERIVED ON EVERY READ AND NEVER PERSISTED — a stored flag
// would be wrong by tomorrow.
//
// ⚠️ Compared in the VIEWER'S LOCAL TIMEZONE via todayIso(now), with no
// normalisation: a boundary can flip a few hours early or late for a user in
// another timezone. The same documented limitation as daysPastDue/isFutureDate
// in lib/payments.js. One clock, injected, never read inside a helper.

export function isOverdue(activity, now = new Date()) {
  if (!activity || !isOpenStatus(activity.status)) return false
  if (!isValidIsoDate(activity.plannedFinish)) return false
  return activity.plannedFinish < todayIso(now)
}

// Days the planned finish is in the past (positive), or null when not overdue.
export function daysLate(activity, now = new Date()) {
  if (!isOverdue(activity, now)) return null
  return daysBetween(activity.plannedFinish, todayIso(now))
}

// Days until the planned finish: 0 = due today, negative = already past.
// null when there is no usable planned finish.
export function daysUntilDue(activity, now = new Date()) {
  if (!activity || !isValidIsoDate(activity.plannedFinish)) return null
  return daysBetween(todayIso(now), activity.plannedFinish)
}

// ── Grouping (drives the mobile card list) ───────────────────────────────────
//
// Rolling windows, not calendar weeks: "this week" as a calendar concept needs
// a week-start convention (Sunday vs Monday) that the app has never defined and
// that would differ from what the user means anyway.
export const ACTIVITY_GROUP = {
  OVERDUE:   'overdue',
  THIS_WEEK: 'this_week',
  UPCOMING:  'upcoming',
  LATER:     'later',
  CLOSED:    'closed',
}

export const ACTIVITY_GROUP_ORDER = [
  ACTIVITY_GROUP.OVERDUE,
  ACTIVITY_GROUP.THIS_WEEK,
  ACTIVITY_GROUP.UPCOMING,
  ACTIVITY_GROUP.LATER,
  ACTIVITY_GROUP.CLOSED,
]

export const ACTIVITY_GROUP_LABELS = {
  [ACTIVITY_GROUP.OVERDUE]:   'Overdue',
  [ACTIVITY_GROUP.THIS_WEEK]: 'This week',
  [ACTIVITY_GROUP.UPCOMING]:  'Upcoming',
  [ACTIVITY_GROUP.LATER]:     'Later',
  [ACTIVITY_GROUP.CLOSED]:    'Completed / Cancelled',
}

export const ACTIVITY_GROUP_HINTS = {
  [ACTIVITY_GROUP.OVERDUE]:   'Planned finish has passed and the activity is not complete',
  [ACTIVITY_GROUP.THIS_WEEK]: 'Due within the next 7 days',
  [ACTIVITY_GROUP.UPCOMING]:  'Due in 7 to 28 days',
  [ACTIVITY_GROUP.LATER]:     'Due beyond 28 days',
  [ACTIVITY_GROUP.CLOSED]:    'No longer outstanding',
}

export const THIS_WEEK_DAYS = 7
export const UPCOMING_DAYS  = 28
// The summary card window. Deliberately independent of the grouping windows —
// two weeks is the look-ahead a site meeting runs on.
export const DUE_SOON_DAYS  = 14

export function activityGroup(activity, now = new Date()) {
  if (!activity) return ACTIVITY_GROUP.LATER
  if (isClosedStatus(activity.status)) return ACTIVITY_GROUP.CLOSED
  if (isOverdue(activity, now)) return ACTIVITY_GROUP.OVERDUE
  const until = daysUntilDue(activity, now)
  // An open activity with an unusable planned finish cannot be placed on the
  // horizon; it sits in Later rather than being dropped from the list.
  if (until === null) return ACTIVITY_GROUP.LATER
  if (until < THIS_WEEK_DAYS) return ACTIVITY_GROUP.THIS_WEEK
  if (until < UPCOMING_DAYS)  return ACTIVITY_GROUP.UPCOMING
  return ACTIVITY_GROUP.LATER
}

// Every group key is always present (possibly empty) so the caller renders a
// stable set of sections. Activities inside each group are deterministically
// sorted.
export function groupActivities(activities, now = new Date()) {
  const out = {}
  for (const key of ACTIVITY_GROUP_ORDER) out[key] = []
  for (const a of activities ?? []) out[activityGroup(a, now)].push(a)
  for (const key of ACTIVITY_GROUP_ORDER) out[key] = sortActivities(out[key])
  return out
}

// True when the activity is due within `days` and still open (0 = due today).
export function isDueWithin(activity, days, now = new Date()) {
  if (!activity || !isOpenStatus(activity.status)) return false
  const until = daysUntilDue(activity, now)
  if (until === null) return false
  return until >= 0 && until <= days
}

// ── Summary (the four desktop cards) ─────────────────────────────────────────
export function timelineSummary(activities, now = new Date()) {
  const list = activities ?? []
  let overdue = 0
  let dueSoon = 0
  let inProgress = 0
  let milestonesRemaining = 0
  let open = 0
  let completed = 0

  for (const a of list) {
    if (isOverdue(a, now)) overdue += 1
    if (isDueWithin(a, DUE_SOON_DAYS, now)) dueSoon += 1
    if (a.status === ACTIVITY_STATUS.IN_PROGRESS) inProgress += 1
    if (a.isMilestone && isOpenStatus(a.status)) milestonesRemaining += 1
    if (isOpenStatus(a.status)) open += 1
    if (a.status === ACTIVITY_STATUS.COMPLETED) completed += 1
  }

  return {
    total: list.length,
    open,
    completed,
    overdue,
    dueSoon,
    dueSoonDays: DUE_SOON_DAYS,
    inProgress,
    milestonesRemaining,
  }
}

// ── Deterministic ordering ───────────────────────────────────────────────────
//
// `sortOrder` is authored client-side and is NOT unique — concurrent creation
// can produce ties, and rules cannot enforce uniqueness (no query, no count).
// Ties therefore break on planned start, then planned finish, then name, then
// document id, so the same list always renders in the same order and rows never
// flicker between renders. Never claim sortOrder uniqueness.
const cmpNullableIso = (a, b) => {
  const av = isValidIsoDate(a) ? a : ''
  const bv = isValidIsoDate(b) ? b : ''
  if (av === bv) return 0
  // Undated sorts last.
  if (av === '') return 1
  if (bv === '') return -1
  return av < bv ? -1 : 1
}

export function compareActivities(a, b) {
  const ao = Number.isFinite(a?.sortOrder) ? a.sortOrder : Number.MAX_SAFE_INTEGER
  const bo = Number.isFinite(b?.sortOrder) ? b.sortOrder : Number.MAX_SAFE_INTEGER
  if (ao !== bo) return ao - bo
  const byStart = cmpNullableIso(a?.plannedStart, b?.plannedStart)
  if (byStart !== 0) return byStart
  const byFinish = cmpNullableIso(a?.plannedFinish, b?.plannedFinish)
  if (byFinish !== 0) return byFinish
  const an = (a?.name ?? '').toLowerCase()
  const bn = (b?.name ?? '').toLowerCase()
  if (an !== bn) return an < bn ? -1 : 1
  return String(a?.id ?? '').localeCompare(String(b?.id ?? ''))
}

// Returns a NEW array — never sorts the caller's list in place.
export function sortActivities(activities) {
  return [...(activities ?? [])].sort(compareActivities)
}

// The next sortOrder to author. Not a reservation and not unique.
export function nextSortOrder(activities) {
  const values = (activities ?? [])
    .map(a => (Number.isFinite(a?.sortOrder) ? a.sortOrder : null))
    .filter(v => v !== null)
  if (values.length === 0) return 10
  return Math.max(...values) + 10
}

// ── Filtering ────────────────────────────────────────────────────────────────
//
// Four controls, all client-side over the loaded snapshot. Deliberately NOT a
// filter builder (docs/PRODUCT.md → "What Constrapp Is Not").
export function filterActivities(activities, filters = {}, now = new Date()) {
  const {
    search = '',
    status = '',
    responsibleContactId = '',
    hideClosed = false,
    overdueOnly = false,
  } = filters
  const needle = search.trim().toLowerCase()

  return (activities ?? []).filter((a) => {
    if (hideClosed && isClosedStatus(a.status)) return false
    if (status && a.status !== status) return false
    if (responsibleContactId && (a.responsibleContactId ?? '') !== responsibleContactId) return false
    if (overdueOnly && !isOverdue(a, now)) return false
    if (needle) {
      const haystack = [a.name, a.description, a.notes, a.responsibleName, a.costCodeName]
        .map(v => (v ?? '').toLowerCase())
        .join(' ')
      if (!haystack.includes(needle)) return false
    }
    return true
  })
}

// The responsible parties present on a programme, for the filter picker.
export function responsibleOptions(activities) {
  const seen = new Map()
  for (const a of activities ?? []) {
    const id = a?.responsibleContactId
    if (!id) continue
    if (!seen.has(id)) seen.set(id, a.responsibleName || id)
  }
  return [...seen.entries()]
    .map(([id, name]) => ({ id, name }))
    .sort((x, y) => x.name.localeCompare(y.name))
}

// ── Draft normalisation & validation ─────────────────────────────────────────
//
// `normaliseActivityDraft` produces EXACTLY the stored field set (minus audit
// stamps), so the hook, the modal, and the validator all agree on one shape and
// the client can never assemble a document the rules block would reject for a
// reason the user never sees.

const trimTo = (v, max) => String(v ?? '').trim().slice(0, max)

export const LIMITS = {
  name: 120,
  description: 500,
  notes: 500,
  responsibleName: 120,
  costCodeName: 120,
  cancelReason: 500,
}

const isoOrNull = (v) => (isValidIsoDate(v) ? v : null)

export function normaliseActivityDraft(draft = {}) {
  const isMilestone = draft.isMilestone === true
  const hasContact  = Boolean(draft.responsibleContactId)
  const hasCostCode = Boolean(draft.costCodeId)
  const percentRaw  = Number(draft.percentComplete)

  return {
    name:        trimTo(draft.name, LIMITS.name),
    description: trimTo(draft.description, LIMITS.description),
    isMilestone,
    status:      draft.status,

    plannedStart:  typeof draft.plannedStart === 'string' ? draft.plannedStart.trim() : '',
    // A milestone is a point in time: its finish is ALWAYS its start, so the
    // form never asks for it twice and the two can never disagree.
    plannedFinish: isMilestone
      ? (typeof draft.plannedStart === 'string' ? draft.plannedStart.trim() : '')
      : (typeof draft.plannedFinish === 'string' ? draft.plannedFinish.trim() : ''),
    actualStart:   isoOrNull(draft.actualStart),
    actualFinish:  isoOrNull(draft.actualFinish),

    percentComplete: Number.isFinite(percentRaw) ? Math.trunc(percentRaw) : NaN,

    responsibleContactId: hasContact ? String(draft.responsibleContactId) : null,
    responsibleName:      hasContact ? trimTo(draft.responsibleName, LIMITS.responsibleName) : '',

    costCodeId:   hasCostCode ? String(draft.costCodeId) : null,
    costCodeName: hasCostCode ? trimTo(draft.costCodeName, LIMITS.costCodeName) : '',

    sortOrder: Number.isFinite(Number(draft.sortOrder)) ? Number(draft.sortOrder) : 0,
    notes:     trimTo(draft.notes, LIMITS.notes),
  }
}

// Returns an error MESSAGE (shown to the user) or null.
//
// Every check here has a counterpart in the `activities` block of
// firestore.rules, and deliberately so: the two must agree exactly or the app
// would assemble writes the server rejects for reasons the user cannot see.
// What rules CANNOT check is listed at the bottom of that block — this
// validator is not a security boundary.
export function validateActivityDraft(draft, { creating = false } = {}) {
  const d = normaliseActivityDraft(draft)

  if (!d.name) return 'Enter an activity name'
  if (String(draft?.name ?? '').trim().length > LIMITS.name) {
    return `Activity name must be ${LIMITS.name} characters or fewer`
  }

  if (!isActivityStatus(d.status)) return 'Choose a status'
  if (d.status === ACTIVITY_STATUS.CANCELLED) {
    return 'Cancel an activity from the programme list — cancellation records a reason'
  }
  if (creating && !isCreatableStatus(d.status)) return 'Choose a status'

  if (!isValidIsoDate(d.plannedStart)) {
    return d.isMilestone ? 'Enter the milestone date' : 'Enter a planned start date'
  }
  if (!isValidIsoDate(d.plannedFinish)) return 'Enter a planned finish date'
  if (d.plannedFinish < d.plannedStart) return 'Planned finish cannot be before planned start'
  if (d.isMilestone && d.plannedFinish !== d.plannedStart) {
    return 'A milestone happens on a single day'
  }

  if (draft?.actualStart && !isValidIsoDate(draft.actualStart)) return 'Actual start is not a valid date'
  if (draft?.actualFinish && !isValidIsoDate(draft.actualFinish)) return 'Actual finish is not a valid date'
  if (d.actualStart && d.actualFinish && d.actualFinish < d.actualStart) {
    return 'Actual finish cannot be before actual start'
  }

  if (!Number.isFinite(d.percentComplete)) return 'Enter progress as a whole number from 0 to 100'
  if (d.percentComplete < 0 || d.percentComplete > 100) return 'Progress must be between 0 and 100'
  if (Number(draft?.percentComplete) !== d.percentComplete) {
    return 'Progress must be a whole number'
  }
  if (d.isMilestone && d.percentComplete !== 0 && d.percentComplete !== 100) {
    return 'A milestone is either not reached (0%) or reached (100%)'
  }

  // Status invariants — the cross-field rules that keep status, progress and
  // actual dates from contradicting each other.
  if (d.status === ACTIVITY_STATUS.NOT_STARTED) {
    if (d.percentComplete !== 0) return 'A not-started activity is 0% complete'
    if (d.actualStart)  return 'A not-started activity has no actual start date'
    if (d.actualFinish) return 'A not-started activity has no actual finish date'
  }
  if (d.status === ACTIVITY_STATUS.IN_PROGRESS && !d.actualStart) {
    return 'An in-progress activity needs an actual start date'
  }
  if (d.status === ACTIVITY_STATUS.COMPLETED) {
    if (d.percentComplete !== 100) return 'A completed activity is 100% complete'
    if (!d.actualFinish) return 'A completed activity needs an actual finish date'
  }

  if (d.responsibleContactId && !d.responsibleName) return 'Choose a responsible contact'
  if (!d.responsibleContactId && d.responsibleName) return 'Choose a responsible contact'
  if (d.costCodeId && !d.costCodeName) return 'Choose a cost code'
  if (!d.costCodeId && d.costCodeName) return 'Choose a cost code'

  if (!Number.isFinite(d.sortOrder)) return 'Programme order must be a number'

  return null
}

export function validateCancelReason(reason) {
  const r = String(reason ?? '').trim()
  if (!r) return 'Enter a reason for cancelling this activity'
  if (r.length > LIMITS.cancelReason) {
    return `The reason must be ${LIMITS.cancelReason} characters or fewer`
  }
  return null
}

// ── Presentation helpers ─────────────────────────────────────────────────────

// 'YYYY-MM-DD' → '14/10/2026'. Programme dates are strings, so formatDate in
// lib/formatters.js (which expects a Firestore Timestamp) does not apply.
export function formatIsoDate(iso) {
  if (!isValidIsoDate(iso)) return '—'
  const [y, m, d] = iso.split('-')
  return `${d}/${m}/${y}`
}

// The plain-language late/due line under a mobile card. Text, never colour
// alone, and never phrased as variance against an approved baseline.
export function dueLabel(activity, now = new Date()) {
  if (!activity) return ''
  if (activity.status === ACTIVITY_STATUS.CANCELLED) return 'Cancelled'
  if (activity.status === ACTIVITY_STATUS.COMPLETED) {
    return activity.actualFinish ? `Finished ${formatIsoDate(activity.actualFinish)}` : 'Completed'
  }
  const late = daysLate(activity, now)
  if (late !== null) return late === 1 ? '1 day late' : `${late} days late`
  const until = daysUntilDue(activity, now)
  if (until === null) return 'No planned finish'
  if (until === 0) return 'Due today'
  if (until === 1) return 'Due tomorrow'
  return `Due in ${until} days`
}

export function durationLabel(activity) {
  const days = activityDuration(activity)
  if (days === null) return '—'
  if (days === 0) return 'Milestone'
  return days === 1 ? '1 day' : `${days} days`
}
