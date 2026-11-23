// ── Project record domain logic (ADR-39) ─────────────────────────────────────
//
// Pure helpers for CREATING and CORRECTING the project record. No Firestore, no
// React — `hooks/useProjects.jsx` owns the writes and `pages/Projects.jsx` owns
// the form.
//
// ⚠️ THIS MODULE PERFORMS NO FINANCIAL ARITHMETIC AND READS NO FINANCIAL FIELD.
// A project's editable fields are metadata: `name`, `status`, `startDate`,
// `location`, `progress`. Every commercial figure on a project is derived at
// read time from budget lines, POs, claims, invoices, credit notes, variations
// and forecast lines — none of which reads any field here. Editing project
// metadata therefore moves NO figure on the Budget, Forecast, Commercial or
// Cash Flow tabs (proven in tests/unit/foundationEditInvariance.test.js).
//
// WHAT IS DELIBERATELY ABSENT: a status transition graph. `status` is
// DESCRIPTIVE, not a lifecycle — repository inspection found its only consumers
// to be two Badges, a status-dot colour lookup, and the Dashboard's
// "In Progress" count. It gates no purchase order, claim, invoice, variation,
// payment or Firestore rule. Restricting transitions in the UI would advertise
// a control that does not exist, so ANY valid status may move to ANY other
// valid status and `Completed` is freely reopenable. If `status` is ever given
// financial meaning, the transition rules belong in Firestore rules first and a
// new ADR — not in a client-side map. See docs/PROJECT_DECISIONS.md → ADR-39.

// THE status vocabulary. These exact display strings are what is stored, what
// `Badge` renders, what the status-dot colour map is keyed by, and what
// `Dashboard.jsx` matches on ('In Progress'). Firestore rules enforce this same
// five-value enum, so the two must not drift — the list is short, product-owned
// and stable, unlike the ISO currency table that firestore.rules deliberately
// shape-tests instead.
export const PROJECT_STATUSES = [
  'Planning',
  'In Progress',
  'Backlogged',
  'On Hold',
  'Completed',
]

export const isProjectStatus = (status) => PROJECT_STATUSES.includes(status)

// The ONLY keys `updateProject` may write. `budget`, `currency` and
// `currencyLocked` are absent BY DESIGN:
//   · `budget` is the creation-time headline figure. It feeds no derivation
//     (the live Approved Budget is Σ budgetLines.budgeted) but it IS currency-
//     lock evidence — `createProject` sets `currencyLocked: budget > 0`, and
//     the ratchet is one-way and rules-enforced. Editing it up would have to
//     engage the ratchet atomically; editing it down could never release it,
//     leaving a permanently locked project whose lock has no visible reason.
//   · `currency`/`currencyLocked` have their own control surface (the Project
//     Overview currency card) and their own rules branches.
//   · `createdAt`/`createdBy` are provenance.
// Firestore rules independently freeze `budget`, `createdAt` and `createdBy` on
// update, so this list is the UX mirror of an enforced boundary — not the
// boundary itself.
export const PROJECT_EDITABLE_KEYS = ['name', 'status', 'startDate', 'location', 'progress']

// Field limits mirrored by firestore.rules. Generous — they exist to reject
// junk and unbounded writes, not to impose an editorial style.
export const PROJECT_NAME_MAX_LENGTH = 200
export const PROJECT_LOCATION_MAX_LENGTH = 200

// Editor form values → the exact stored shape, applying the SAME normalisation
// `createProject` has always applied: name/location trimmed, progress coerced
// and clamped to 0–100, and a blank date meaning "no start date" rather than an
// Invalid Date.
//
// `startDate` is returned as a 'YYYY-MM-DD' string or null; the hook converts
// it to a Firestore Timestamp, because pages and lib never import firebase/*.
// A cleared date is NULL, not '' — the stored field is `Timestamp | null` and
// blanking it must restore the same "no start date" state a project created
// without one has.
export function buildProjectFields({ name, status, startDate, location, progress }) {
  return {
    name:      String(name ?? '').trim(),
    status,
    startDate: startDate ? String(startDate) : null,
    location:  String(location ?? '').trim(),
    progress:  clampProgress(progress),
  }
}

// Coerces to a whole 0–100 number. Non-numeric input becomes 0 rather than NaN,
// matching `createProject`'s `Number(progress) || 0`; the value is a manually
// entered percentage and is financially inert (`projects.progress` is written
// by nobody else — the Project Timeline explicitly does not touch it).
export function clampProgress(progress) {
  const n = Number(progress)
  if (!Number.isFinite(n)) return 0
  return Math.min(100, Math.max(0, n))
}

// Returns null when valid, otherwise the first error message.
// Deliberately NOT validated: any status-to-status move (see the module note).
export function validateProjectEdit({ name, status, location }) {
  const trimmedName = String(name ?? '').trim()
  if (!trimmedName) return 'Project name is required.'
  if (trimmedName.length > PROJECT_NAME_MAX_LENGTH) {
    return `Project name must be ${PROJECT_NAME_MAX_LENGTH} characters or fewer.`
  }
  if (!isProjectStatus(status)) return 'Choose a valid project status.'
  if (String(location ?? '').trim().length > PROJECT_LOCATION_MAX_LENGTH) {
    return `Location must be ${PROJECT_LOCATION_MAX_LENGTH} characters or fewer.`
  }
  return null
}

// A stored Timestamp → the 'YYYY-MM-DD' string an <input type="date"> needs.
// Returns '' for null/absent (a project with no start date) and for anything
// that is not a Firestore Timestamp, so a malformed legacy value opens the
// editor blank instead of throwing.
export function projectStartDateToInput(startDate) {
  if (!startDate || typeof startDate.toDate !== 'function') return ''
  const d = startDate.toDate()
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

// ── Project register state (Dashboard) ───────────────────────────────────────
//
// Three facts the register must never collapse into each other:
//   loading      → the subscription has not reported yet
//   unavailable  → the read FAILED (most often a rules rejection) — this is NOT
//                  "no projects", and saying so would state a false fact
//   empty        → the read settled and the company genuinely has no projects
export const PROJECTS_LIST_STATE = {
  LOADING:     'loading',
  UNAVAILABLE: 'unavailable',
  EMPTY:       'empty',
  READY:       'ready',
}

export function projectsListState({ loading, error, count }) {
  if (loading) return PROJECTS_LIST_STATE.LOADING
  if (error) return PROJECTS_LIST_STATE.UNAVAILABLE
  return (Number(count) || 0) > 0 ? PROJECTS_LIST_STATE.READY : PROJECTS_LIST_STATE.EMPTY
}

// Count of projects per status, in PROJECT_STATUSES order. A project whose
// stored status is outside the vocabulary (legacy data predating the rules
// enum) is counted under `other` rather than dropped, so the counts always sum
// to the project total. NON-financial — status is descriptive (ADR-39).
export function projectStatusCounts(projects) {
  const counts = Object.fromEntries(PROJECT_STATUSES.map(s => [s, 0]))
  let other = 0
  for (const p of projects ?? []) {
    if (isProjectStatus(p?.status)) counts[p.status] += 1
    else other += 1
  }
  return {
    byStatus: PROJECT_STATUSES.map(status => ({ status, count: counts[status] })),
    other,
  }
}

// ── Portfolio summary (Dashboard v2, ADR-45) ─────────────────────────────────
//
// The Dashboard's company-wide layer: project COUNTS only, never money.
// `active` / `total` / `statusCounts` are null until the projects read has
// SETTLED cleanly — so a loading or failed read can never render as
// "0 active projects" (the v1 defect this fixes). A settled empty company is a
// genuine zero. `active` counts the descriptive 'In Progress' status (ADR-39).
export function portfolioSummary({ projects, loading, error }) {
  const list = Array.isArray(projects) ? projects : []
  const listState = projectsListState({ loading, error, count: list.length })
  const settled = listState === PROJECTS_LIST_STATE.READY || listState === PROJECTS_LIST_STATE.EMPTY
  return {
    listState,
    active:       settled ? list.filter(p => p?.status === 'In Progress').length : null,
    total:        settled ? list.length : null,
    statusCounts: settled ? projectStatusCounts(list) : null,
  }
}

// Geometry for the Dashboard's status distribution bar: each status's share of
// the project COUNT, as percentage offsets/widths. Counts only — no money.
// Zero-count statuses are omitted; an empty company draws nothing.
export function statusBarSegments(statusCounts) {
  if (!statusCounts) return []
  const entries = [
    ...statusCounts.byStatus.map(({ status, count }) => ({ status, label: status, count })),
    ...(statusCounts.other > 0 ? [{ status: 'Other', label: 'Other status', count: statusCounts.other }] : []),
  ]
  const total = entries.reduce((s, e) => s + e.count, 0)
  if (total <= 0) return []
  let offset = 0
  const out = []
  for (const e of entries) {
    if (e.count <= 0) continue
    const widthPct = e.count / total * 100
    out.push({ ...e, offsetPct: offset, widthPct })
    offset += widthPct
  }
  return out
}

// ── How the project route presents the projects read (L3 Stage 2) ────────────
//
// `useProject` finds one project in the company's live projects list. Four
// different facts used to collapse into "Project not found.":
//
//   NOT_FOUND          the SERVER's list was read and this id is not in it
//   PERMISSION_DENIED  the list read was refused by Firestore rules
//   UNAVAILABLE        the list read failed for any other reason; the listener
//                      has ended and only a retry re-opens it
//   OFFLINE            the only answer so far is the local cache (the SDK
//                      answers an unreachable backend with an EMPTY cached
//                      list) — the listener is alive and recovers by itself
//
// A project that IS in the list is READY even when the list came from cache:
// it was read from the server earlier in this session.
//
// ⚠️ Presentation only. Nothing here grants or withholds access — Firestore
// rules decide what the list contains. A project in another company, or one
// that never existed, is NOT_FOUND either way, so the wording discloses
// nothing about records the caller cannot read.
export const PROJECT_LOAD_STATE = {
  LOADING:           'loading',
  READY:             'ready',
  NOT_FOUND:         'not-found',
  PERMISSION_DENIED: 'permission-denied',
  UNAVAILABLE:       'unavailable',
  OFFLINE:           'offline',
}

export function projectLoadState({ loading, error, errorCode, fromCache, found }) {
  if (loading) return PROJECT_LOAD_STATE.LOADING
  if (error) {
    return errorCode === 'permission-denied'
      ? PROJECT_LOAD_STATE.PERMISSION_DENIED
      : PROJECT_LOAD_STATE.UNAVAILABLE
  }
  if (found) return PROJECT_LOAD_STATE.READY
  if (fromCache) return PROJECT_LOAD_STATE.OFFLINE
  return PROJECT_LOAD_STATE.NOT_FOUND
}

// ── External project isolation (M2-A2) ───────────────────────────────────────
//
// WHO READS WHAT. Three audiences, and every role outside the first two reads
// no project at all:
//   · INTERNAL  company_admin / project_manager / qs — the project document,
//     every project of their company (unchanged).
//   · ASSIGNED  client / subcontractor — the DIRECTORY ENTRY of each project
//     listed in their own users/{uid}.projectIds, and nothing else. They never
//     read the project document, so its headline budget and currency are not
//     in anything they can load.
//   · everyone else (super_admin, an unknown or missing role) — nothing.
//
// ⚠️ Presentation and query selection only. Firestore Security Rules are the
// boundary: they refuse the project document to a non-internal role and refuse
// a directory entry, drawing, document or file of an unassigned project. The
// predicates below choose WHICH read to open so the app never issues one the
// rules would refuse — they grant nothing.
export const PROJECT_INTERNAL_ROLES = ['company_admin', 'project_manager', 'qs']
export const PROJECT_ASSIGNED_ROLES = ['client', 'subcontractor']
export const readsProjectDocuments = (role) => PROJECT_INTERNAL_ROLES.includes(role)
export const readsAssignedProjects = (role) => PROJECT_ASSIGNED_ROLES.includes(role)

// The five display fields a directory entry holds — and the ONLY five. Rules
// refuse any other key and any value that differs from the project document
// in the same commit, so this list is the mirror of an enforced shape.
export const PROJECT_DIRECTORY_KEYS = ['name', 'status', 'location', 'startDate', 'progress']

// The directory entry for a project being written, taken from the EXACT values
// going into the project document in the same batch (`startDate` is already a
// Timestamp or null by then). Anything else on the input is dropped.
export function projectDirectoryFields({ name, status, location, startDate, progress }) {
  return { name, status, location, startDate, progress }
}

// One listener per assigned project, so the list is bounded. An assignment
// beyond the cap is not subscribed (it stays readable by rules; it is simply
// not listed) — a user needing more is a provisioning question, not a UI one.
export const ASSIGNED_PROJECTS_MAX = 30

const PROJECT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/

// The caller's assigned project ids, from their own profile: well-formed ids
// only, de-duplicated, sorted (a stable subscription key) and capped. A
// missing, null or malformed `projectIds` is NO assignment — the same answer
// the rules give.
export function assignedProjectIds(profile) {
  if (!profile || !readsAssignedProjects(profile.role)) return []
  const raw = profile.projectIds
  if (!Array.isArray(raw)) return []
  const ids = [...new Set(raw.filter(id => typeof id === 'string' && PROJECT_ID_RE.test(id)))]
  return ids.sort().slice(0, ASSIGNED_PROJECTS_MAX)
}

// The state of the assigned-directory subscription (useProjectDirectory).
// `key` is null until EVERY listener of the current target has reported, so
// the list is never shown half-loaded (a project still in flight would read as
// "not found"). Reports for the target in flight collect in `pending`.
export const EMPTY_DIRECTORY_SNAPSHOT = {
  key: null, projects: [], error: false, readCode: null, fromCache: false, attempt: 0, pending: null,
}

// Fold ONE listener report into the snapshot. `report` is
// `{ project, fromCache, code }`: `project` is the entry (or null when the
// document does not exist or the read failed) and `code` the Firestore error
// code of a failed read.
//   · an entry that does not exist, or that rules refuse, is simply not in the
//     list — an assignment the server no longer honours is not an outage;
//   · any other failure makes the whole list `error` (a list with a silent
//     hole would state a false "you have N projects").
// Entries keep the order of `ids`. Pure; a report for another target is ignored.
export function foldDirectoryReport(snap, key, ids, id, report) {
  const pending = snap.pending && snap.pending.key === key ? snap.pending : { key, byId: {} }
  if (!ids.includes(id)) return snap
  const byId = { ...pending.byId, [id]: report }
  const next = { key, byId }
  if (!ids.every(i => byId[i])) return { ...snap, pending: next }
  const failed = ids.map(i => byId[i]).find(r => r.code && r.code !== 'permission-denied')
  return {
    key,
    projects: failed ? [] : ids.map(i => byId[i].project).filter(Boolean),
    error: !!failed,
    readCode: failed ? failed.code : null,
    fromCache: ids.some(i => byId[i].fromCache === true),
    attempt: snap.attempt,
    pending: next,
  }
}
