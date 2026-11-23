import { CODE, fail } from './errors.js'

// ── Input validation — PURE ──────────────────────────────────────────────────
//
// Strict schemas: every callable declares the exact keys it accepts, unknown
// keys are refused, and every value is shape-checked before any Firestore or
// Auth call. The client mirrors the email and name rules for UX only; this
// file is the authority.

export const INTERNAL_ROLES = ['company_admin', 'project_manager', 'qs']
export const isInternalRole = (r) => INTERNAL_ROLES.includes(r)

// The three roles the operator may provision out of band. They appear in
// listTeam as "managed by operator" and are never assignable or invitable
// through the callables (ADR-72 scope control).
export const OPERATOR_ROLES = ['super_admin', 'subcontractor', 'client']

// ADR-75 Stage 3 narrows ONE part of that scope: a Company Admin may
// DEACTIVATE a subcontractor or client. super_admin remains operator-only.
// Removal only — provisioning an external member is still an operator task.
export const isDeactivatableRole = (r) => r !== 'super_admin'

// M2-A2 Stage B (ADR-84) — the two roles that may hold a project assignment.
// `users/{uid}.projectIds` is read by the Rules for these two roles ONLY
// (ADR-83); for every other role it is ignored there and must not exist here.
export const EXTERNAL_ROLES = ['client', 'subcontractor']
export const isExternalRole = (r) => EXTERNAL_ROLES.includes(r)

// The application opens one listener per assigned project, capped at 30
// (ADR-83 decision 8). An assignment the application could not show is refused.
export const MAX_PROJECT_ASSIGNMENTS = 30

export const EMAIL_MAX = 254
export const NAME_MAX = 80
export const ID_RE = /^[A-Za-z0-9_-]{1,64}$/
// RFC 5322-shaped, deliberately simple: one @, no whitespace, a dotted domain.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export const normaliseEmail = (v) => (typeof v === 'string' ? v.trim().toLowerCase() : '')

export const isValidEmail = (v) =>
  typeof v === 'string' && v.length > 0 && v.length <= EMAIL_MAX && EMAIL_RE.test(v)

export const isValidName = (v) =>
  typeof v === 'string' && v.trim().length >= 1 && v.trim().length <= NAME_MAX

export const isValidId = (v) => typeof v === 'string' && ID_RE.test(v)

// base64url of 32 random bytes is 43 characters.
export const isTokenShape = (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{43}$/.test(v)

// ── Project assignments — PURE (M2-A2 Stage B, ADR-84) ───────────────────────
//
// A list of project ids, checked for SHAPE only: whether each project exists
// in the member's company is a Firestore read, done inside the transaction
// that uses the list (lib/memberProjects.js → missingProjects).
//
// Returns `{ ok: true, projectIds }` — a new array, SORTED, so two equal
// assignments are equal arrays — or `{ ok: false, reason, projectId? }`.
// Nothing is repaired: a duplicate is refused, never removed.
export const ASSIGNMENT_PROBLEM = {
  MISSING:   'missing',
  MALFORMED: 'malformed',
  EMPTY:     'empty',
  TOO_MANY:  'too-many',
  DUPLICATE: 'duplicate',
  ROLE:      'role',
  NOT_FOUND: 'project-not-found',
  CONFLICT:  'add-remove-conflict',
}

export function checkProjectIds(value, { min = 1, max = MAX_PROJECT_ASSIGNMENTS } = {}) {
  if (value === undefined || value === null) return { ok: false, reason: ASSIGNMENT_PROBLEM.MISSING }
  if (!Array.isArray(value)) return { ok: false, reason: ASSIGNMENT_PROBLEM.MALFORMED }
  const seen = new Set()
  for (const id of value) {
    if (!isValidId(id)) return { ok: false, reason: ASSIGNMENT_PROBLEM.MALFORMED }
    if (seen.has(id)) return { ok: false, reason: ASSIGNMENT_PROBLEM.DUPLICATE, projectId: id }
    seen.add(id)
  }
  if (value.length < min) return { ok: false, reason: ASSIGNMENT_PROBLEM.EMPTY }
  if (value.length > max) return { ok: false, reason: ASSIGNMENT_PROBLEM.TOO_MANY }
  return { ok: true, projectIds: [...value].sort() }
}

// What an invitation for `role` may carry, and therefore what acceptance
// writes to `users/{uid}.projectIds`:
//   client / subcontractor → 1–30 unique ids, REQUIRED
//   the three internal roles → NO assignment at all (the field must be absent)
//   anything else (super_admin, an unknown role, no role) → refused
// Used when an invitation is created AND again, on the stored record, when it
// is accepted — the invitation document is never trusted on its own.
export function invitationAssignment(role, projectIds) {
  if (isExternalRole(role)) {
    const checked = checkProjectIds(projectIds)
    return checked.ok ? { ok: true, external: true, projectIds: checked.projectIds } : checked
  }
  if (isInternalRole(role)) {
    if (projectIds !== undefined && projectIds !== null) return { ok: false, reason: ASSIGNMENT_PROBLEM.ROLE }
    return { ok: true, external: false, projectIds: null }
  }
  return { ok: false, reason: ASSIGNMENT_PROBLEM.ROLE }
}

// The assignment a profile holds NOW, as far as it can be trusted: the string
// ids of a list, de-duplicated and sorted. Anything else (absent, null, not a
// list) is no assignment — exactly how the Rules read it. `sound` is false
// when the stored value was not already that clean list.
export function currentAssignment(stored) {
  if (stored === undefined || stored === null) return { projectIds: [], sound: true }
  if (!Array.isArray(stored)) return { projectIds: [], sound: false }
  const ids = [...new Set(stored.filter(isValidId))].sort()
  return { projectIds: ids, sound: ids.length === stored.length && ids.every((id, i) => id === stored[i]) }
}

// The assignment after an operator's change, or why it is refused.
//   { set: [...] }                  → exactly this list (0–30; empty removes all)
//   { add: [...], remove: [...] }   → resolved against `current`, so two
//                                     operators adding at once both land
// Adding an id already held, or removing one not held, changes nothing — a
// repeated request is safe.
export function resolveAssignmentChange(current, change) {
  const c = change ?? {}
  const hasSet = c.set !== undefined
  const hasDelta = c.add !== undefined || c.remove !== undefined
  if (hasSet === hasDelta) return { ok: false, reason: ASSIGNMENT_PROBLEM.MALFORMED }
  let next
  if (hasSet) {
    const set = checkProjectIds(c.set, { min: 0 })
    if (!set.ok) return set
    next = set.projectIds
  } else {
    const add = checkProjectIds(c.add ?? [], { min: 0 })
    if (!add.ok) return add
    const remove = checkProjectIds(c.remove ?? [], { min: 0 })
    if (!remove.ok) return remove
    if (add.projectIds.length + remove.projectIds.length === 0) return { ok: false, reason: ASSIGNMENT_PROBLEM.EMPTY }
    const clash = add.projectIds.find(id => remove.projectIds.includes(id))
    if (clash) return { ok: false, reason: ASSIGNMENT_PROBLEM.CONFLICT, projectId: clash }
    next = [...new Set([...current, ...add.projectIds])].filter(id => !remove.projectIds.includes(id)).sort()
    if (next.length > MAX_PROJECT_ASSIGNMENTS) return { ok: false, reason: ASSIGNMENT_PROBLEM.TOO_MANY }
  }
  return {
    ok: true,
    projectIds: next,
    added: next.filter(id => !current.includes(id)),
    removed: current.filter(id => !next.includes(id)),
  }
}

function requireObject(data) {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    fail(CODE.INVALID_ARGUMENT, { field: 'data' })
  }
  return data
}

function refuseUnknownKeys(data, allowed) {
  for (const k of Object.keys(data)) {
    if (!allowed.includes(k)) fail(CODE.INVALID_ARGUMENT, { field: k, reason: 'unknown' })
  }
}

// Each parser returns a clean, normalised object or throws invalid-argument.

export function parseEmpty(data) {
  const d = requireObject(data ?? {})
  refuseUnknownKeys(d, [])
  return {}
}

export function parseCreateInvitation(data) {
  const d = requireObject(data)
  refuseUnknownKeys(d, ['email', 'role'])
  const email = normaliseEmail(d.email)
  if (!isValidEmail(email)) fail(CODE.INVALID_ARGUMENT, { field: 'email' })
  if (!isInternalRole(d.role)) fail(CODE.INVALID_ROLE, { field: 'role' })
  return { email, role: d.role }
}

export function parseInviteId(data) {
  const d = requireObject(data)
  refuseUnknownKeys(d, ['inviteId'])
  if (!isValidId(d.inviteId)) fail(CODE.INVALID_ARGUMENT, { field: 'inviteId' })
  return { inviteId: d.inviteId }
}

export function parseInviteCredential(data, extraKeys = []) {
  const d = requireObject(data)
  refuseUnknownKeys(d, ['companyId', 'inviteId', 'token', ...extraKeys])
  if (!isValidId(d.companyId)) fail(CODE.INVALID_ARGUMENT, { field: 'companyId' })
  if (!isValidId(d.inviteId)) fail(CODE.INVALID_ARGUMENT, { field: 'inviteId' })
  if (!isTokenShape(d.token)) fail(CODE.INVALID_ARGUMENT, { field: 'token' })
  return { companyId: d.companyId, inviteId: d.inviteId, token: d.token }
}

export function parseAcceptInvitation(data) {
  const base = parseInviteCredential(data, ['name'])
  const name = typeof data.name === 'string' ? data.name.trim() : ''
  if (data.name !== undefined && !isValidName(name)) fail(CODE.INVALID_ARGUMENT, { field: 'name' })
  return { ...base, name }
}

export function parseChangeMemberRole(data) {
  const d = requireObject(data)
  refuseUnknownKeys(d, ['uid', 'role', 'expectedRole'])
  if (!isValidId(d.uid) || d.uid.length > 128) fail(CODE.INVALID_ARGUMENT, { field: 'uid' })
  if (!isInternalRole(d.role)) fail(CODE.INVALID_ROLE, { field: 'role' })
  if (!isInternalRole(d.expectedRole)) fail(CODE.INVALID_ARGUMENT, { field: 'expectedRole' })
  return { uid: d.uid, role: d.role, expectedRole: d.expectedRole }
}

export function parseMemberUid(data) {
  const d = requireObject(data)
  refuseUnknownKeys(d, ['uid'])
  if (typeof d.uid !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(d.uid)) {
    fail(CODE.INVALID_ARGUMENT, { field: 'uid' })
  }
  return { uid: d.uid }
}
