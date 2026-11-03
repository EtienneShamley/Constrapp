import { Timestamp } from './firebaseAdmin.js'
import { CODE, fail } from './errors.js'
import { AUDIT, auditInTx, auditNow } from './audit.js'
import { withCompanyLock, countActiveAdmins, membersCollection, usersCollection } from './companyLock.js'
import { userRef } from './authz.js'
import { OPERATOR_ROLES } from './validation.js'
import { MEMBER_STATUS, isActiveMemberOf, isDeactivated, toIso } from './membershipState.js'

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
  const { db, auth } = deps
  const [activeSnap, membersSnap] = await Promise.all([
    usersCollection(db).where('companyId', '==', companyId).get(),
    membersCollection(db, companyId).get(),
  ])

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
    })
  }
  for (const d of membersSnap.docs) {
    const m = d.data()
    if (byUid.has(d.id)) {
      const row = byUid.get(d.id)
      if (!row.email && m.email) row.email = m.email
      if (!row.joinedAt && m.joinedAt) row.joinedAt = toIso(m.joinedAt)
      continue
    }
    if (m.status !== MEMBER_STATUS.DEACTIVATED) continue
    byUid.set(d.id, {
      uid: d.id, name: m.name ?? '', email: m.email ?? null, role: m.role ?? null,
      status: MEMBER_STATUS.DEACTIVATED, managed: 'team', joinedAt: toIso(m.joinedAt),
      authSyncPending: m.authSyncPending === true, deactivatedAt: toIso(m.deactivatedAt),
      isSelf: d.id === callerUid, legacy: false,
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
    const snap = await tx.get(userRef(db, uid))
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
    tx.update(userRef(db, uid), { role, updatedAt: ts, updatedBy: actor.uid })
    tx.set(membersCollection(db, companyId).doc(uid), {
      role, status: MEMBER_STATUS.ACTIVE, email: profile.email ?? null, name: profile.name ?? '', updatedAt: ts,
    }, { merge: true })
    auditInTx(tx, db, companyId, {
      type: AUDIT.MEMBER_ROLE_CHANGED, actorUid: actor.uid, targetUid: uid, targetEmail: profile.email ?? null,
      before: { role: profile.role }, after: { role }, requestId, source,
    }, nowDate)
    return { uid, role, changed: true }
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
    const [snap, memberSnap] = await Promise.all([
      tx.get(userRef(db, uid)), tx.get(membersCollection(db, companyId).doc(uid)),
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
    tx.update(userRef(db, uid), {
      companyId: null, role: null, status: MEMBER_STATUS.DEACTIVATED,
      formerCompanyId: companyId, formerRole: profile.role,
      deactivatedAt: ts, deactivatedBy: actor.uid, authSyncPending: true,
      updatedAt: ts, updatedBy: actor.uid,
    })
    tx.set(membersCollection(db, companyId).doc(uid), {
      email: profile.email ?? null, name: profile.name ?? '', role: profile.role,
      status: MEMBER_STATUS.DEACTIVATED, deactivatedAt: ts, deactivatedBy: actor.uid,
      authSyncPending: true, updatedAt: ts,
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
  return { uid, status: MEMBER_STATUS.DEACTIVATED, changed: outcome.changed, authSynced }
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
