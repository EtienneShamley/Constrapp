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
// listTeam as "managed by operator" and are never assignable or deactivatable
// through the callables (ADR-72 scope control).
export const OPERATOR_ROLES = ['super_admin', 'subcontractor', 'client']

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
