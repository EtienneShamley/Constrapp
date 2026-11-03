import { FieldValue, Timestamp } from './firebaseAdmin.js'
import { CODE, fail } from './errors.js'
import { generateToken, hashToken, tokenMatchesHash, buildInviteLink } from './tokens.js'
import { consumeRateLimit, LIMITS, rateKey } from './rateLimit.js'
import { AUDIT, auditInTx, auditNow } from './audit.js'
import { EmailError, renderInviteEmail } from './email.js'
import { withCompanyLock, companyRef, invitationsCollection, membersCollection } from './companyLock.js'
import { userRef } from './authz.js'
import {
  INVITE_STATUS, MEMBER_STATUS, effectiveInviteStatus, isActiveMember, isActiveMemberOf, toIso,
} from './membershipState.js'

// ── Invitation lifecycle ─────────────────────────────────────────────────────
//
//   pending ──(accept)──▶ accepted
//   pending ──(revoke)──▶ revoked
//   pending ──(resend)──▶ pending   (token ROTATED, expiry reset, attempts 0)
//   "expired" and "locked" are DERIVED from a pending record at read time.
//
// The document never holds the raw token — only its SHA-256 hash (and the
// previous hash after a rotation, so an old link is refused WITHOUT counting
// as a guess against the new one).
//
// Every function takes `deps`: { db, auth, email, now, config, log }.

export const DELIVERY = { EMAIL: 'email', OPERATOR: 'operator' }

export async function lookupAuthUserByEmail(auth, email) {
  try {
    return await auth.getUserByEmail(email)
  } catch (err) {
    if (err?.code === 'auth/user-not-found') return null
    throw err
  }
}

const publicInvite = (id, inv, now) => ({
  inviteId: id,
  email: inv.email,
  role: inv.role,
  status: effectiveInviteStatus(inv, now),
  expiresAt: toIso(inv.expiresAt),
  createdAt: toIso(inv.createdAt),
  createdBy: inv.createdBy ?? null,
  sentAt: toIso(inv.sentAt),
  sendCount: inv.sendCount ?? 0,
  deliveredVia: inv.deliveredVia ?? null,
  delivery: inv.lastSendError ? 'failed' : (inv.sentAt ? 'sent' : (inv.deliveredVia === DELIVERY.OPERATOR ? 'operator' : 'pending')),
  lastSendError: inv.lastSendError ?? null,
})

// ── Create ───────────────────────────────────────────────────────────────────

export async function createInvitation(deps, { companyId, actor, email, role, deliveredVia = DELIVERY.EMAIL, requestId = null, source = 'callable' }) {
  const { db, auth, now, config } = deps
  const nowDate = now()
  const cfg = config()

  if (deliveredVia === DELIVERY.EMAIL) {
    if (!cfg.appBaseUrl) fail(CODE.APP_URL_NOT_CONFIGURED)
  }

  if (source === 'callable') {
    await consumeRateLimit(db, { companyId, key: rateKey('invite-create', actor.uid), ...LIMITS.INVITE_CREATE_ADMIN, now: nowDate })
    await consumeRateLimit(db, { companyId, key: rateKey('invite-create', 'company'), ...LIMITS.INVITE_CREATE_COMPANY, now: nowDate })
  }

  // Already an active member of THIS company? Refuse. A member of ANOTHER
  // company is not revealed here — acceptance refuses that case to the
  // invitee, who already knows their own situation.
  const authUser = await lookupAuthUserByEmail(auth, email)
  if (authUser) {
    const snap = await userRef(db, authUser.uid).get()
    if (snap.exists && isActiveMemberOf(snap.data(), companyId)) fail(CODE.ALREADY_MEMBER)
  }

  const token = generateToken()
  const expiresAt = new Date(nowDate.getTime() + cfg.inviteTtlMs)
  const inviteRef = invitationsCollection(db, companyId).doc()

  await withCompanyLock(db, companyId, nowDate, async (tx) => {
    const pending = await tx.get(invitationsCollection(db, companyId)
      .where('email', '==', email).where('status', '==', INVITE_STATUS.PENDING))
    if (!pending.empty) fail(CODE.INVITE_PENDING, { inviteId: pending.docs[0].id })

    tx.create(inviteRef, {
      email, role,
      status: INVITE_STATUS.PENDING,
      tokenHash: hashToken(token),
      previousTokenHash: null,
      expiresAt: Timestamp.fromDate(expiresAt),
      createdBy: actor.uid,
      createdByName: actor.name ?? null,
      createdAt: Timestamp.fromDate(nowDate),
      updatedAt: Timestamp.fromDate(nowDate),
      deliveredVia,
      sentAt: null, sendCount: 0, lastSendError: null, lastSendAt: null,
      failedAttempts: 0,
      acceptedUid: null, acceptedAt: null,
      revokedBy: null, revokedAt: null,
      reactivatedUid: null,
    })
    auditInTx(tx, db, companyId, {
      type: AUDIT.INVITE_CREATED, actorUid: actor.uid, targetEmail: email, inviteId: inviteRef.id,
      after: { role, expiresAt: expiresAt.toISOString(), deliveredVia }, requestId, source,
    }, nowDate)
  })

  const link = buildInviteLink(cfg.appBaseUrl || 'http://localhost', { companyId, inviteId: inviteRef.id, token })

  let delivery = DELIVERY.OPERATOR
  if (deliveredVia === DELIVERY.EMAIL) {
    delivery = await deliverInvitation(deps, { companyId, inviteId: inviteRef.id, email, role, link, expiresAt, actor })
  }

  return {
    inviteId: inviteRef.id, email, role, expiresAt: expiresAt.toISOString(), delivery,
    // The raw link leaves this module ONLY for operator-delivered invitations
    // (the bootstrap script prints it). The callable never returns it.
    ...(deliveredVia === DELIVERY.OPERATOR ? { link } : {}),
  }
}

// Sends the email and records the outcome on the invitation. Never throws for
// an email failure; returns 'sent' | 'failed'.
export async function deliverInvitation(deps, { companyId, inviteId, email, role, link, expiresAt, actor }) {
  const { db, email: mailer, now, log } = deps
  const nowDate = now()
  const company = await companyRef(db, companyId).get()
  const companyName = company.exists ? (company.data().name ?? 'your company') : 'your company'
  const rendered = renderInviteEmail({ companyName, inviterName: actor?.name ?? null, role, link, expiresAt })
  const inviteRef = invitationsCollection(db, companyId).doc(inviteId)
  try {
    const { providerId } = await mailer.send({
      to: email, ...rendered,
      idempotencyKey: `invite-${inviteId}-${nowDate.getTime()}`,
      meta: { companyId, inviteId, link },
    })
    await inviteRef.update({
      sentAt: Timestamp.fromDate(nowDate), lastSendAt: Timestamp.fromDate(nowDate),
      sendCount: FieldValue.increment(1), lastSendError: null, lastProviderId: providerId ?? null,
      updatedAt: Timestamp.fromDate(nowDate),
    })
    return 'sent'
  } catch (err) {
    const code = err instanceof EmailError ? err.code : 'unexpected'
    log?.error?.('invitation email failed', { companyId, inviteId, code, message: err?.message })
    await inviteRef.update({
      lastSendAt: Timestamp.fromDate(nowDate), lastSendError: code, updatedAt: Timestamp.fromDate(nowDate),
    })
    return 'failed'
  }
}

// ── Resend (token rotation) ──────────────────────────────────────────────────

export async function resendInvitation(deps, { companyId, actor, inviteId, requestId = null, source = 'callable' }) {
  const { db, now, config } = deps
  const nowDate = now()
  const cfg = config()
  if (!cfg.appBaseUrl) fail(CODE.APP_URL_NOT_CONFIGURED)

  const inviteRef = invitationsCollection(db, companyId).doc(inviteId)
  const before = await inviteRef.get()
  if (!before.exists) fail(CODE.NOT_FOUND)

  if (source === 'callable') {
    await consumeRateLimit(db, { companyId, key: rateKey('invite-resend', inviteId), ...LIMITS.INVITE_RESEND, now: nowDate })
  }

  const token = generateToken()
  const expiresAt = new Date(nowDate.getTime() + cfg.inviteTtlMs)

  const inv = await withCompanyLock(db, companyId, nowDate, async (tx) => {
    const snap = await tx.get(inviteRef)
    if (!snap.exists) fail(CODE.NOT_FOUND)
    const data = snap.data()
    if (data.status === INVITE_STATUS.ACCEPTED) fail(CODE.INVITATION_ACCEPTED)
    if (data.status === INVITE_STATUS.REVOKED) fail(CODE.INVITATION_REVOKED)
    tx.update(inviteRef, {
      tokenHash: hashToken(token),
      previousTokenHash: data.tokenHash,
      expiresAt: Timestamp.fromDate(expiresAt),
      failedAttempts: 0,
      lastSendError: null,
      updatedAt: Timestamp.fromDate(nowDate),
      deliveredVia: DELIVERY.EMAIL,
    })
    auditInTx(tx, db, companyId, {
      type: AUDIT.INVITE_RESENT, actorUid: actor.uid, targetEmail: data.email, inviteId,
      before: { expiresAt: toIso(data.expiresAt) }, after: { expiresAt: expiresAt.toISOString() }, requestId, source,
    }, nowDate)
    return data
  })

  const link = buildInviteLink(cfg.appBaseUrl, { companyId, inviteId, token })
  const delivery = await deliverInvitation(deps, { companyId, inviteId, email: inv.email, role: inv.role, link, expiresAt, actor })
  return { inviteId, email: inv.email, role: inv.role, expiresAt: expiresAt.toISOString(), delivery }
}

// ── Revoke (idempotent) ──────────────────────────────────────────────────────

export async function revokeInvitation(deps, { companyId, actor, inviteId, requestId = null, source = 'callable' }) {
  const { db, now } = deps
  const nowDate = now()
  const inviteRef = invitationsCollection(db, companyId).doc(inviteId)
  return withCompanyLock(db, companyId, nowDate, async (tx) => {
    const snap = await tx.get(inviteRef)
    if (!snap.exists) fail(CODE.NOT_FOUND)
    const data = snap.data()
    if (data.status === INVITE_STATUS.REVOKED) return { inviteId, status: INVITE_STATUS.REVOKED, changed: false }
    if (data.status === INVITE_STATUS.ACCEPTED) fail(CODE.INVITATION_ACCEPTED)
    tx.update(inviteRef, {
      status: INVITE_STATUS.REVOKED, revokedBy: actor.uid, revokedAt: Timestamp.fromDate(nowDate),
      updatedAt: Timestamp.fromDate(nowDate),
    })
    auditInTx(tx, db, companyId, {
      type: AUDIT.INVITE_REVOKED, actorUid: actor.uid, targetEmail: data.email, inviteId,
      before: { status: data.status }, after: { status: INVITE_STATUS.REVOKED }, requestId, source,
    }, nowDate)
    return { inviteId, status: INVITE_STATUS.REVOKED, changed: true }
  })
}

// ── Lookup by credential (preview / accept) ──────────────────────────────────
//
// Order matters for enumeration and for abuse:
//   1. the invitation must EXIST before any counter is touched (so random ids
//      cannot create rate-limit documents under arbitrary company paths);
//   2. the per-invitation lookup limit is consumed;
//   3. the hash is compared in constant time; a mismatch counts one failed
//      attempt unless it matches the PREVIOUS (rotated-away) token;
//   4. only after a match does the precise derived status come back.

export async function lookupInvitation(deps, { companyId, inviteId, token }) {
  const { db, now } = deps
  const nowDate = now()
  const inviteRef = invitationsCollection(db, companyId).doc(inviteId)
  const snap = await inviteRef.get()
  if (!snap.exists) fail(CODE.INVALID_INVITATION)
  const inv = snap.data()

  await consumeRateLimit(db, { companyId, key: rateKey('invite-lookup', inviteId), ...LIMITS.INVITE_LOOKUP, now: nowDate })

  if (!tokenMatchesHash(token, inv.tokenHash)) {
    const superseded = inv.previousTokenHash && tokenMatchesHash(token, inv.previousTokenHash)
    if (!superseded) {
      await inviteRef.update({ failedAttempts: FieldValue.increment(1), updatedAt: Timestamp.fromDate(nowDate) })
    }
    fail(CODE.INVALID_INVITATION)
  }

  const status = effectiveInviteStatus(inv, nowDate)
  return { ref: inviteRef, id: inviteId, data: inv, status }
}

function failForStatus(status) {
  if (status === INVITE_STATUS.EXPIRED) fail(CODE.INVITATION_EXPIRED)
  if (status === INVITE_STATUS.LOCKED) fail(CODE.INVITATION_LOCKED)
  if (status === INVITE_STATUS.REVOKED) fail(CODE.INVITATION_REVOKED)
  if (status === INVITE_STATUS.ACCEPTED) fail(CODE.INVITATION_ACCEPTED)
}

// ── Preview ──────────────────────────────────────────────────────────────────
//
// Unauthenticated (App Check only). Tells the token holder what they are
// accepting and which path to take. `accountState`:
//   new            — no Auth account for the invited email: register first
//   existing       — an enabled Auth account: sign in, then accept
//   reactivated    — the account was disabled by a deactivation and has no
//                    active membership anywhere; it is RE-ENABLED here, so the
//                    holder can sign in (or reset their password through the
//                    normal Firebase flow) and then accept. The uid is kept.
//   already-member — already an active member of this company
//   other-company  — an active member of another company (cannot accept)
//   blocked        — a disabled account that still holds an active membership
//                    somewhere: not touched; contact the operator

export async function previewInvitation(deps, cred, { requestId = null } = {}) {
  const { db, auth, now, log } = deps
  const nowDate = now()
  const found = await lookupInvitation(deps, cred)
  const inv = found.data
  // Accepted invitations are reported precisely (the holder used it).
  failForStatus(found.status)

  const company = await companyRef(db, cred.companyId).get()
  const companyName = company.exists ? (company.data().name ?? '') : ''

  let accountState = 'new'
  const authUser = await lookupAuthUserByEmail(auth, inv.email)
  if (authUser) {
    const profileSnap = await userRef(db, authUser.uid).get()
    const profile = profileSnap.exists ? profileSnap.data() : null
    if (isActiveMemberOf(profile, cred.companyId)) {
      accountState = 'already-member'
    } else if (isActiveMember(profile)) {
      accountState = authUser.disabled ? 'blocked' : 'other-company'
    } else if (authUser.disabled) {
      // Secure reactivation: the holder of a valid, unexpired invitation
      // delivered to this mailbox may have the Auth account re-enabled. It
      // still has NO membership — a bare Auth account opens nothing — until
      // acceptInvitation succeeds with the same token.
      await auth.updateUser(authUser.uid, { disabled: false })
      await found.ref.update({ reactivatedUid: authUser.uid, updatedAt: Timestamp.fromDate(nowDate) })
      await auditNow(db, cred.companyId, {
        type: AUDIT.MEMBER_AUTH_REENABLED, actorUid: null, targetUid: authUser.uid, targetEmail: inv.email,
        inviteId: cred.inviteId, before: { disabled: true }, after: { disabled: false }, requestId,
      }, nowDate)
      log?.info?.('auth account re-enabled by invitation', { companyId: cred.companyId, inviteId: cred.inviteId })
      accountState = 'reactivated'
    } else {
      accountState = 'existing'
    }
  }

  return {
    companyId: cred.companyId,
    inviteId: cred.inviteId,
    companyName,
    email: inv.email,
    role: inv.role,
    inviterName: inv.createdByName ?? null,
    expiresAt: toIso(inv.expiresAt),
    accountState,
  }
}

// ── Accept ───────────────────────────────────────────────────────────────────
//
// Authenticated. Possession of the token (hash match) AND the Auth record's
// email (read server-side from Firebase Auth, never from the client) must both
// line up with the invitation. One transaction establishes the membership and
// consumes the invitation; a repeat by the same uid returns the same result.

export async function acceptInvitation(deps, { cred, callerUid, name = '', requestId = null }) {
  const { db, auth, now, log } = deps
  const nowDate = now()
  const found = await lookupInvitation(deps, cred)
  const inv = found.data

  if (found.status === INVITE_STATUS.ACCEPTED) {
    if (inv.acceptedUid === callerUid) {
      return { uid: callerUid, companyId: cred.companyId, role: inv.role, alreadyAccepted: true }
    }
    fail(CODE.INVITATION_ACCEPTED)
  }
  failForStatus(found.status)

  const authUser = await auth.getUser(callerUid)
  if (authUser.disabled) fail(CODE.ACCOUNT_BLOCKED)
  const authEmail = (authUser.email ?? '').trim().toLowerCase()
  if (!authEmail || authEmail !== inv.email) fail(CODE.EMAIL_MISMATCH)

  const resolvedName = name || authUser.displayName || ''

  const result = await withCompanyLock(db, cred.companyId, nowDate, async (tx) => {
    const [inviteSnap, profileSnap] = await Promise.all([tx.get(found.ref), tx.get(userRef(db, callerUid))])
    if (!inviteSnap.exists) fail(CODE.INVALID_INVITATION)
    const current = inviteSnap.data()
    const status = effectiveInviteStatus(current, nowDate)
    if (status === INVITE_STATUS.ACCEPTED) {
      if (current.acceptedUid === callerUid) return { alreadyAccepted: true, role: current.role }
      fail(CODE.INVITATION_ACCEPTED)
    }
    failForStatus(status)
    if (!tokenMatchesHash(cred.token, current.tokenHash)) fail(CODE.INVALID_INVITATION)

    const profile = profileSnap.exists ? profileSnap.data() : null
    if (isActiveMemberOf(profile, cred.companyId)) fail(CODE.ALREADY_MEMBER)
    if (isActiveMember(profile)) fail(CODE.MEMBER_OF_OTHER_COMPANY)

    const ts = Timestamp.fromDate(nowDate)
    const existingName = profile?.name
    const finalName = resolvedName || existingName || ''

    // users/{uid} — the ONE authoritative membership record.
    tx.set(userRef(db, callerUid), {
      name: finalName,
      email: inv.email,
      role: current.role,
      companyId: cred.companyId,
      status: MEMBER_STATUS.ACTIVE,
      joinedAt: ts,
      inviteId: cred.inviteId,
      updatedAt: ts,
      updatedBy: callerUid,
      formerCompanyId: null, formerRole: null,
      deactivatedAt: null, deactivatedBy: null,
      authSyncPending: false,
    }, { merge: true })

    // members/{uid} — history and listing; never a source of permissions.
    tx.set(membersCollection(db, cred.companyId).doc(callerUid), {
      email: inv.email, name: finalName, role: current.role, status: MEMBER_STATUS.ACTIVE,
      joinedAt: ts, invitedBy: current.createdBy ?? null, inviteId: cred.inviteId,
      deactivatedAt: null, deactivatedBy: null, authSyncPending: false, updatedAt: ts,
    }, { merge: true })

    tx.update(found.ref, {
      status: INVITE_STATUS.ACCEPTED, acceptedUid: callerUid, acceptedAt: ts, updatedAt: ts,
    })

    auditInTx(tx, db, cred.companyId, {
      type: AUDIT.INVITE_ACCEPTED, actorUid: callerUid, targetUid: callerUid, targetEmail: inv.email,
      inviteId: cred.inviteId, before: { status: profile?.status ?? null, companyId: profile?.companyId ?? null },
      after: { role: current.role, companyId: cred.companyId }, requestId,
    }, nowDate)

    return { alreadyAccepted: false, role: current.role, name: finalName }
  })

  // Mailbox possession is proven only when the link travelled by email to the
  // invited address and the signed-in account IS that address. An
  // operator-delivered invitation (bootstrap) proves nothing about the mailbox.
  if (!result.alreadyAccepted && inv.deliveredVia === DELIVERY.EMAIL && !authUser.emailVerified) {
    try {
      await auth.updateUser(callerUid, { emailVerified: true })
    } catch (err) {
      log?.warn?.('emailVerified update failed', { uid: callerUid, message: err?.message })
    }
  }

  return { uid: callerUid, companyId: cred.companyId, role: result.role, name: result.name ?? resolvedName, alreadyAccepted: result.alreadyAccepted }
}

export async function listPendingInvitations(db, companyId, now) {
  const snap = await invitationsCollection(db, companyId).where('status', '==', INVITE_STATUS.PENDING).get()
  return snap.docs.map(d => publicInvite(d.id, d.data(), now))
    .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))
}
