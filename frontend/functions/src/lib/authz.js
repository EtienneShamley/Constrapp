import { CODE, fail } from './errors.js'
import { isActiveMember, isDeactivated } from './membershipState.js'

// ── Caller authorisation ─────────────────────────────────────────────────────
//
// The Admin SDK bypasses Security Rules, so EVERY privileged callable
// re-establishes the caller's membership here, from `users/{uid}` — the same
// document the rules trust — and derives the company from it. No callable
// accepts a companyId for an admin operation; a cross-tenant request cannot
// even be expressed.

export const userRef = (db, uid) => db.collection('users').doc(uid)

export function requireAuth(request) {
  const uid = request?.auth?.uid
  if (typeof uid !== 'string' || uid.length === 0) fail(CODE.UNAUTHENTICATED)
  return { uid, token: request.auth.token ?? {} }
}

export async function loadProfile(db, uid) {
  const snap = await userRef(db, uid).get()
  return snap.exists ? { id: snap.id, ...snap.data() } : null
}

// Admin-only entry point. Returns the caller's uid, company and profile.
export async function requireCompanyAdmin(db, request) {
  const { uid } = requireAuth(request)
  const profile = await loadProfile(db, uid)
  if (!profile) fail(CODE.NO_MEMBERSHIP)
  if (isDeactivated(profile)) fail(CODE.MEMBERSHIP_INACTIVE)
  if (!isActiveMember(profile)) fail(CODE.NO_MEMBERSHIP)
  if (profile.role !== 'company_admin') fail(CODE.NOT_ADMIN)
  return { uid, companyId: profile.companyId, profile }
}

export function requireEnabled(config) {
  if (config?.enabled === false) fail(CODE.DISABLED)
}
