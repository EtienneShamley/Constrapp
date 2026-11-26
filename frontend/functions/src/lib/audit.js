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
  // ADR-77 — one event per approved Final Account revision, in its transaction.
  FINAL_ACCOUNT_APPROVED:             'final_account.approved',
  // ADR-81 — one event per BOQ transfer that CHANGED a working budget line, in
  // its transaction. A transfer that writes nothing writes no event.
  BOQ_BUDGET_TRANSFERRED:             'boq_budget.transferred',
  // ADR-84 — an operator changed an external member's project assignment.
  // `before` and `after` each carry the complete `projectIds` list. A request
  // that changes nothing writes no event.
  MEMBER_PROJECTS_CHANGED:            'member.projects_changed',
  // ADR-89 — one event per committed posting or void of a client credit note
  // or client retention release, in its transaction. `before` and `after`
  // each carry the invoice ledger's totals; a repeated request writes none.
  CLIENT_CREDIT_NOTE_POSTED:          'client_credit_note.posted',
  CLIENT_CREDIT_NOTE_VOIDED:          'client_credit_note.voided',
  CLIENT_RETENTION_RELEASE_POSTED:    'client_retention_release.posted',
  CLIENT_RETENTION_RELEASE_VOIDED:    'client_retention_release.voided',
  // ADR-89 — one event per committed posting or void of a client receipt, in
  // its transaction: the amount, and what each allocation added to (or took
  // back from) the received figure of its invoice's ledger.
  CLIENT_RECEIPT_POSTED:              'client_receipt.posted',
  CLIENT_RECEIPT_VOIDED:              'client_receipt.voided',
  // ADR-89 — ONE event per project, ever, in the transaction that brings the
  // receipts posted before the backend took over into the invoice ledgers.
  // Counts and whole cents only.
  CLIENT_RECEIPT_BASELINE_ESTABLISHED: 'client_receipt.baseline_established',
  // ADR-89 — an operator switched client credit notes and retention releases
  // on or off for ONE company (scripts/set-client-finance.mjs). `before` and
  // `after` carry the flag only; a run that changes nothing writes no event.
  COMPANY_CLIENT_FINANCE_SET:          'company.client_finance_set',
  // ADR-89 (S6) — the same script with --receipts: trusted receipt processing
  // for ONE company while receipts are not yet open to every company.
  COMPANY_CLIENT_RECEIPTS_SET:         'company.client_receipts_set',
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
