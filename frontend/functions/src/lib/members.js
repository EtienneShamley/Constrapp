import { Timestamp } from './firebaseAdmin.js'
import { CODE, fail } from './errors.js'
import { AUDIT, auditInTx, auditNow } from './audit.js'
import { withCompanyLock, countActiveAdmins, membersCollection, usersCollection } from './companyLock.js'
import { userRef } from './authz.js'
import { OPERATOR_ROLES } from './validation.js'
import { MEMBER_STATUS, isActiveMemberOf, isDeactivated, toIso } from './membershipState.js'
import { REASON, stateRef as fileLinkStateRef, requestRevocationInTx, reducesFileAccess, fileLinkRow } from './fileLinkRevocation.js'

// ── Members: list, role change, deactivation ─────────────────────────────────

const AUTH_BATCH = 100

async function authRecords(auth, uids) {
  const out = new Map()
  for (let i = 0; i < uids.length; i += AUTH_BATCH) {
    const chunk = uids.slice(i, i + AUTH_BATCH).map(uid => ({ uid }))
    if (chunk.length === 0) continue
    const res = await auth.getUsers(chunk)
    for (const u of res.users) out.set(u.uid, u)
  }
  return out
}

export async function listMembers(deps, { companyId, callerUid }) {
  const { db, auth, now } = deps
  const [activeSnap, membersSnap, fileLinkSnap] = await Promise.all([
    usersCollection(db).where('companyId', '==', companyId).get(),
    membersCollection(db, companyId).get(),
    fileLinkStateRef(db, companyId).get(),
  ])
  // ADR-74: whether links a member copied earlier have been revoked yet. A
  // status, counts and times only — never a token.
  const fileLinkState = fileLinkSnap.exists ? fileLinkSnap.data() : null
  const nowMs = now().getTime()

  const byUid = new Map()
  for (const d of activeSnap.docs) {
    const u = d.data()
    if (isDeactivated(u)) continue
    byUid.set(d.id, {
      uid: d.id,
      name: u.name ?? '',
      email: u.email ?? null,
      role: u.role ?? null,
      status: MEMBER_STATUS.ACTIVE,
      managed: OPERATOR_ROLES.includes(u.role) ? 'operator' : 'team',
      joinedAt: toIso(u.joinedAt),
      authSyncPending: u.authSyncPending === true,
      deactivatedAt: null,
      isSelf: d.id === callerUid,
      legacy: u.status === undefined,
      fileLinks: null,
    })
  }
  for (const d of membersSnap.docs) {
    const m = d.data()
    if (byUid.has(d.id)) {
      const row = byUid.get(d.id)
      if (!row.email && m.email) row.email = m.email
      if (!row.joinedAt && m.joinedAt) row.joinedAt = toIso(m.joinedAt)
      row.fileLinks = fileLinkRow(m, { deactivated: false }, fileLinkState, nowMs)
      continue
    }
    if (m.status !== MEMBER_STATUS.DEACTIVATED) continue
    byUid.set(d.id, {
      uid: d.id, name: m.name ?? '', email: m.email ?? null, role: m.role ?? null,
      status: MEMBER_STATUS.DEACTIVATED, managed: 'team', joinedAt: toIso(m.joinedAt),
      authSyncPending: m.authSyncPending === true, deactivatedAt: toIso(m.deactivatedAt),
      isSelf: d.id === callerUid, legacy: false,
      fileLinks: fileLinkRow(m, { deactivated: true }, fileLinkState, nowMs),
    })
  }

  const records = await authRecords(auth, [...byUid.keys()])
  for (const row of byUid.values()) {
    const rec = records.get(row.uid)
    row.authDisabled = rec ? rec.disabled === true : null
    row.lastSignInAt = rec?.metadata?.lastSignInTime ? new Date(rec.metadata.lastSignInTime).toISOString() : null
    if (!row.email && rec?.email) row.email = rec.email
  }

  return [...byUid.values()].sort((a, b) =>
    (a.status === b.status ? 0 : a.status === MEMBER_STATUS.ACTIVE ? -1 : 1)
    || (a.name || a.email || '').localeCompare(b.name || b.email || ''))
}

// ── Role change ──────────────────────────────────────────────────────────────

export async function changeMemberRole(deps, { companyId, actor, uid, role, expectedRole, requestId = null, source = 'callable' }) {
  const { db, now } = deps
  const nowDate = now()
  if (uid === actor.uid) fail(CODE.SELF_TARGET)

  return withCompanyLock(db, companyId, nowDate, async (tx) => {
    const [snap, fileLinkSnap] = await Promise.all([tx.get(userRef(db, uid)), tx.get(fileLinkStateRef(db, companyId))])
    const profile = snap.exists ? snap.data() : null
    // Not a member of the caller's company → not-found, revealing nothing.
    if (!isActiveMemberOf(profile, companyId)) fail(CODE.NOT_FOUND)
    if (OPERATOR_ROLES.includes(profile.role)) fail(CODE.UNSUPPORTED_TARGET)
    if (profile.role !== expectedRole) fail(CODE.STALE_EXPECTATION, { currentRole: profile.role })
    if (profile.role === role) return { uid, role, changed: false }

    if (profile.role === 'company_admin') {
      const admins = await countActiveAdmins(tx, db, companyId)
      if (admins <= 1) fail(CODE.LAST_ADMIN)
    }

    const ts = Timestamp.fromDate(nowDate)
    // ADR-74: a change that REDUCES file access queues a background sweep of
    // the company's legacy download tokens, in this same transaction. The role
    // itself changes now; old links are revoked later, never "immediately".
    const fileLinks = reducesFileAccess(profile.role, role)
      ? { fileLinkRevocationSeq: requestRevocationInTx(tx, db, companyId, fileLinkSnap, { now: nowDate, actorUid: actor.uid, targetUid: uid, reason: REASON.ROLE_REDUCED, requestId, source }), fileAccessReducedAt: ts }
      : {}
    tx.update(userRef(db, uid), { role, updatedAt: ts, updatedBy: actor.uid })
    tx.set(membersCollection(db, companyId).doc(uid), {
      role, status: MEMBER_STATUS.ACTIVE, email: profile.email ?? null, name: profile.name ?? '', updatedAt: ts, ...fileLinks,
    }, { merge: true })
    auditInTx(tx, db, companyId, {
      type: AUDIT.MEMBER_ROLE_CHANGED, actorUid: actor.uid, targetUid: uid, targetEmail: profile.email ?? null,
      before: { role: profile.role }, after: { role }, requestId, source,
    }, nowDate)
    return { uid, role, changed: true, fileLinksRevocationQueued: 'fileLinkRevocationSeq' in fileLinks }
  })
}

// ── Deactivation ─────────────────────────────────────────────────────────────
//
// Firestore FIRST (authoritative; every later rules check denies at once),
// then Auth (disable + revoke refresh tokens). A failed Auth step leaves
// `authSyncPending: true`, and a repeat call — or the reconcile script —
// completes it. Nothing here claims to kill an ID token already issued: those
// live up to an hour, and the client signs itself out on membership loss.

export async function deactivateMember(deps, { companyId, actor, uid, requestId = null, source = 'callable' }) {
  const { db, now } = deps
  const nowDate = now()
  if (uid === actor.uid) fail(CODE.SELF_TARGET)

  const outcome = await withCompanyLock(db, companyId, nowDate, async (tx) => {
    const [snap, memberSnap, fileLinkSnap] = await Promise.all([
      tx.get(userRef(db, uid)), tx.get(membersCollection(db, companyId).doc(uid)), tx.get(fileLinkStateRef(db, companyId)),
    ])
    const profile = snap.exists ? snap.data() : null
    const member = memberSnap.exists ? memberSnap.data() : null

    if (!isActiveMemberOf(profile, companyId)) {
      // Already deactivated FROM THIS company → idempotent; finish Auth sync.
      const deactivatedHere = profile && isDeactivated(profile) && profile.formerCompanyId === companyId
        && member?.status === MEMBER_STATUS.DEACTIVATED
      if (deactivatedHere) return { changed: false, authSyncPending: profile.authSyncPending === true, email: profile.email ?? null }
      fail(CODE.NOT_FOUND)
    }
    if (OPERATOR_ROLES.includes(profile.role)) fail(CODE.UNSUPPORTED_TARGET)
    if (profile.role === 'company_admin') {
      const admins = await countActiveAdmins(tx, db, companyId)
      if (admins <= 1) fail(CODE.LAST_ADMIN)
    }

    const ts = Timestamp.fromDate(nowDate)
    // ADR-74: queue the background sweep of legacy download tokens in the SAME
    // transaction that ends the membership — the request can never be lost,
    // and the membership never waits for it.
    const fileLinkRevocationSeq = requestRevocationInTx(tx, db, companyId, fileLinkSnap, {
      now: nowDate, actorUid: actor.uid, targetUid: uid, reason: REASON.DEACTIVATED, requestId, source,
    })
    tx.update(userRef(db, uid), {
      companyId: null, role: null, status: MEMBER_STATUS.DEACTIVATED,
      formerCompanyId: companyId, formerRole: profile.role,
      deactivatedAt: ts, deactivatedBy: actor.uid, authSyncPending: true,
      updatedAt: ts, updatedBy: actor.uid,
    })
    tx.set(membersCollection(db, companyId).doc(uid), {
      email: profile.email ?? null, name: profile.name ?? '', role: profile.role,
      status: MEMBER_STATUS.DEACTIVATED, deactivatedAt: ts, deactivatedBy: actor.uid,
      authSyncPending: true, updatedAt: ts, fileLinkRevocationSeq, fileAccessReducedAt: ts,
    }, { merge: true })
    auditInTx(tx, db, companyId, {
      type: AUDIT.MEMBER_DEACTIVATED, actorUid: actor.uid, targetUid: uid, targetEmail: profile.email ?? null,
      before: { role: profile.role, companyId }, after: { role: null, companyId: null, status: MEMBER_STATUS.DEACTIVATED },
      requestId, source,
    }, nowDate)
    return { changed: true, authSyncPending: true, email: profile.email ?? null }
  })

  let authSynced = !outcome.authSyncPending
  if (outcome.authSyncPending) {
    authSynced = await syncDeactivatedAuth(deps, { companyId, uid, actorUid: actor.uid, requestId, source })
  }
  // `fileLinks` is 'pending' whenever THIS call queued the sweep — old links
  // are NOT revoked yet (listTeam reports when they are).
  return { uid, status: MEMBER_STATUS.DEACTIVATED, changed: outcome.changed, authSynced, fileLinks: outcome.changed ? 'pending' : null }
}

// Disable the Auth account and revoke its refresh tokens; clear the pending
// flag only once both succeeded. Returns true when synced.
export async function syncDeactivatedAuth(deps, { companyId, uid, actorUid = null, requestId = null, source = 'callable' }) {
  const { db, auth, now, log } = deps
  const nowDate = now()
  try {
    await auth.updateUser(uid, { disabled: true })
    await auth.revokeRefreshTokens(uid)
  } catch (err) {
    log?.error?.('auth sync failed; left pending', { companyId, uid, message: err?.message })
    return false
  }
  const ts = Timestamp.fromDate(nowDate)
  await Promise.all([
    userRef(db, uid).set({ authSyncPending: false, authSyncedAt: ts }, { merge: true }),
    membersCollection(db, companyId).doc(uid).set({ authSyncPending: false, authSyncedAt: ts }, { merge: true }),
  ])
  await auditNow(db, companyId, {
    type: AUDIT.MEMBER_AUTH_SYNCED, actorUid, targetUid: uid, after: { disabled: true, refreshTokensRevoked: true }, requestId, source,
  }, nowDate)
  return true
}
