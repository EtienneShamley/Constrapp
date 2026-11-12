import { Timestamp } from './firebaseAdmin.js'

// ── Audit events ─────────────────────────────────────────────────────────────
//
// `companies/{c}/auditEvents/{id}` — append-only, Admin-SDK-only (no rules
// block, so browsers can neither read nor write it). Written INSIDE the same
// transaction as the change it records, so an event never exists without its
// change and a change never commits without its event.
//
// Kept SEPARATE from `users/{uid}` (ADR-27) and from `members/{uid}`: history
// is evidence, never a second source of permissions.

export const AUDIT = {
  INVITE_CREATED:        'invite.created',
  INVITE_RESENT:         'invite.resent',
  INVITE_REVOKED:        'invite.revoked',
  INVITE_ACCEPTED:       'invite.accepted',
  MEMBER_ROLE_CHANGED:   'member.role_changed',
  MEMBER_DEACTIVATED:    'member.deactivated',
  MEMBER_AUTH_SYNCED:    'member.auth_synced',
  MEMBER_AUTH_REENABLED: 'member.auth_reenabled',
  COMPANY_BOOTSTRAPPED:  'company.bootstrapped',
  RECONCILE_FIX:         'reconcile.fix',
  // ADR-74 — counts and sequence numbers only; never a token value.
  FILE_LINKS_REVOCATION_REQUESTED:  'file_links.revocation_requested',
  FILE_LINKS_REVOKED:               'file_links.revoked',
  FILE_LINKS_REVOCATION_INCOMPLETE: 'file_links.revocation_incomplete',
  // ADR-75 — a ROUTINE sweep that removed at least one token, and a company
  // that has gone two intervals without a successful sweep. A routine request,
  // and a routine sweep that found nothing, write no event.
  FILE_LINKS_RECONCILED:              'file_links.reconciled',
  FILE_LINKS_RECONCILIATION_OVERDUE:  'file_links.reconciliation_overdue',
}

export const auditCollection = (db, companyId) =>
  db.collection('companies').doc(companyId).collection('auditEvents')

export function auditPayload({ type, actorUid = null, targetUid = null, targetEmail = null, inviteId = null, before = null, after = null, requestId = null, source = 'callable' }, now) {
  if (!Object.values(AUDIT).includes(type)) throw new Error(`Unknown audit type: ${type}`)
  return {
    type, actorUid, targetUid, targetEmail, inviteId, before, after, requestId, source,
    at: Timestamp.fromDate(now),
  }
}

// Inside a transaction: tx.create on a fresh document id.
export function auditInTx(tx, db, companyId, event, now) {
  tx.create(auditCollection(db, companyId).doc(), auditPayload(event, now))
}

// Outside a transaction (post-commit Auth sync, operator scripts).
export function auditNow(db, companyId, event, now) {
  return auditCollection(db, companyId).doc().create(auditPayload(event, now))
}
