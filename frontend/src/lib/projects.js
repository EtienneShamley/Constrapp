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
