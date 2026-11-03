// ── Membership state — PURE readers over users/{uid} ─────────────────────────
//
// `users/{uid}` stays the ONE authoritative membership document (ADR-27). Every
// Firestore and Storage rule authorises by reading its `companyId` and `role`;
// the callables read the same fields, through these helpers, so the backend
// and the rules can never disagree about who is a member.
//
// Legacy profiles (provisioned before ADR-72) carry no `status`. A missing
// status means ACTIVE — exactly how the rules treat them, since rules never
// read `status` at all.

export const MEMBER_STATUS = { ACTIVE: 'active', DEACTIVATED: 'deactivated' }

export const isDeactivated = (userDoc) => userDoc?.status === MEMBER_STATUS.DEACTIVATED

// An active member OF A COMPANY: the document exists, is not deactivated and
// names a company. A profile with `companyId: null` is what deactivation
// leaves behind, and it is a member of nothing.
export const isActiveMember = (userDoc) =>
  !!userDoc && !isDeactivated(userDoc) && typeof userDoc.companyId === 'string' && userDoc.companyId.length > 0

export const isActiveMemberOf = (userDoc, companyId) =>
  isActiveMember(userDoc) && userDoc.companyId === companyId

export const isActiveAdminOf = (userDoc, companyId) =>
  isActiveMemberOf(userDoc, companyId) && userDoc.role === 'company_admin'

// The invitation's EFFECTIVE status at `now`: stored status first, then the
// derived expiry / lock states that are never written back.
export const INVITE_STATUS = {
  PENDING:  'pending',
  ACCEPTED: 'accepted',
  REVOKED:  'revoked',
  EXPIRED:  'expired',
  LOCKED:   'locked',
}

export const INVITE_MAX_FAILED_ATTEMPTS = 10

export function effectiveInviteStatus(invite, now) {
  if (!invite) return null
  if (invite.status !== INVITE_STATUS.PENDING) return invite.status
  if ((invite.failedAttempts ?? 0) >= INVITE_MAX_FAILED_ATTEMPTS) return INVITE_STATUS.LOCKED
  const exp = toMillis(invite.expiresAt)
  if (exp !== null && exp <= now.getTime()) return INVITE_STATUS.EXPIRED
  return INVITE_STATUS.PENDING
}

export function toMillis(v) {
  if (v === null || v === undefined) return null
  if (typeof v === 'number') return v
  if (v instanceof Date) return v.getTime()
  if (typeof v.toMillis === 'function') return v.toMillis()
  if (typeof v.seconds === 'number') return v.seconds * 1000 + Math.floor((v.nanoseconds ?? 0) / 1e6)
  return null
}

export const toIso = (v) => {
  const ms = toMillis(v)
  return ms === null ? null : new Date(ms).toISOString()
}
