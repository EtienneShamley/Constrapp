import { Timestamp } from './firebaseAdmin.js'
import { CODE, fail } from './errors.js'
import { AUDIT, auditInTx } from './audit.js'
import { withCompanyLock, companyRef, membersCollection, invitationsCollection } from './companyLock.js'
import { userRef } from './authz.js'
import {
  ASSIGNMENT_PROBLEM, isExternalRole, isValidEmail, normaliseEmail, isValidId,
  invitationAssignment, currentAssignment, resolveAssignmentChange,
} from './validation.js'
import { INVITE_STATUS, MEMBER_STATUS, isActiveMember, isActiveMemberOf } from './membershipState.js'
import { REASON, stateRef as fileLinkStateRef, requestRevocationInTx } from './fileLinkRevocation.js'
import { missingProjects } from './projectAssignments.js'
import { createInvitation, lookupAuthUserByEmail, DELIVERY } from './invitations.js'

// ── External members: provisioning and assignment — OPERATOR ONLY (ADR-84) ───
//
// The bodies of scripts/provision-external-member.mjs and
// scripts/set-member-projects.mjs, with Firestore, Auth and the clock injected
// so every decision is tested against the emulators.
//
// ⚠️ NOTHING HERE IS A CALLABLE. No handler in team/handlers.js and no export
// of index.js reaches this file (functions/test/memberProjects.test.js pins
// it). The Admin SDK bypasses the Rules, so these functions are the whole
// control: they run only from an operator's terminal, under the operator's own
// credentials, against a project named on the command line.
//
// There is no self-service path: a client or subcontractor exists only because
// an operator provisioned an invitation here, and reads only the projects an
// operator assigned here.

const OPERATOR = { uid: 'operator', name: 'Operator' }

const refuse = (problem) => fail(CODE.INVALID_ASSIGNMENT, {
  reason: problem.reason,
  ...(problem.projectId ? { projectId: problem.projectId } : {}),
  ...(problem.projectIds ? { projectIds: problem.projectIds } : {}),
})

// ── Provisioning ─────────────────────────────────────────────────────────────
//
// Creates ONE operator-delivered invitation for a client or subcontractor,
// carrying the projects they will read. The membership itself is created by
// the existing acceptInvitation path, which re-checks the role and every
// project before it writes anything.
//
//   dryRun === true   READS ONLY: every check below, no write of any kind.
//   dryRun === false  the same checks, then createInvitation — which repeats
//                     the project check INSIDE its transaction.
//
// The returned `link` is the raw acceptance link. It is a credential: the
// caller must never print or log it.

export async function provisionExternalMember(deps, { companyId, email: rawEmail, role, projectIds, dryRun = true, actor = OPERATOR, requestId = null }) {
  const { db, auth } = deps
  if (!isValidId(companyId)) fail(CODE.INVALID_ARGUMENT, { field: 'companyId' })
  const email = normaliseEmail(rawEmail)
  if (!isValidEmail(email)) fail(CODE.INVALID_ARGUMENT, { field: 'email' })
  // Only the two external roles: an internal member is invited from the Team
  // page, and nothing else is provisioned here.
  if (!isExternalRole(role)) fail(CODE.INVALID_ROLE, { field: 'role' })
  const assignment = invitationAssignment(role, projectIds)
  if (!assignment.ok) refuse(assignment)

  const company = await companyRef(db, companyId).get()
  if (!company.exists) fail(CODE.NOT_FOUND, { what: 'company' })

  // The account, if one exists. An operator may be told what an invitee
  // would be told at acceptance — it is the operator's own company's data.
  let account = 'new'
  const authUser = await lookupAuthUserByEmail(auth, email)
  if (authUser) {
    const snap = await userRef(db, authUser.uid).get()
    const profile = snap.exists ? snap.data() : null
    if (isActiveMemberOf(profile, companyId)) fail(CODE.ALREADY_MEMBER)
    if (isActiveMember(profile)) fail(CODE.MEMBER_OF_OTHER_COMPANY)
    account = authUser.disabled ? 'disabled' : 'existing'
  }

  const pending = await invitationsCollection(db, companyId)
    .where('email', '==', email).where('status', '==', INVITE_STATUS.PENDING).get()
  if (!pending.empty) fail(CODE.INVITE_PENDING, { inviteId: pending.docs[0].id })

  const missing = await missingProjects(db, db, companyId, assignment.projectIds)
  if (missing.length > 0) refuse({ reason: ASSIGNMENT_PROBLEM.NOT_FOUND, projectIds: missing })

  const plan = { companyId, companyName: company.data().name ?? '', email, role, projectIds: assignment.projectIds, account }
  if (dryRun) return { ...plan, dryRun: true }

  const created = await createInvitation(deps, {
    companyId, actor, email, role, projectIds: assignment.projectIds,
    deliveredVia: DELIVERY.OPERATOR, source: 'operator', requestId,
  })
  return { ...plan, dryRun: false, inviteId: created.inviteId, expiresAt: created.expiresAt, link: created.link }
}

// ── Assignment change ────────────────────────────────────────────────────────
//
// Sets, adds to or removes from the projects of ONE active client or
// subcontractor. `change` is `{ set: [...] }` or `{ add: [...], remove: [...] }`
// (validation.js → resolveAssignmentChange).
//
// One transaction under the company membership lock — the lock every
// membership mutation takes — so this serialises with acceptance,
// deactivation and any other assignment change. Inside it:
//   · the company exists, and the member is ACTIVE in it (else not-found)
//   · the member's role is client or subcontractor (else invalid-assignment)
//   · EVERY project of the resulting list exists in that company
//   · `users/{uid}.projectIds` is replaced by the resulting list
//   · when a project was REMOVED, an urgent file-link revocation request is
//     queued (ADR-74), in this same commit
//   · one `member.projects_changed` audit event, with the complete list
//     before and after
// A change that leaves the list as it is writes none of these and returns
// `changed: false` — repeating a request is safe.
//
// ⚠️ Removing a project takes effect at once in the Rules (they read
// `users/{uid}` on every request). A download URL the member copied earlier
// keeps working until the queued sweep has finished — never "immediately".

async function planAssignment(tx, db, { companyId, uid, change }) {
  const [companySnap, profileSnap, fileLinkSnap] = await Promise.all([
    tx.get(companyRef(db, companyId)), tx.get(userRef(db, uid)), tx.get(fileLinkStateRef(db, companyId)),
  ])
  if (!companySnap.exists) fail(CODE.NOT_FOUND, { what: 'company' })
  const profile = profileSnap.exists ? profileSnap.data() : null
  // Not an active member of THIS company — deactivated, another company's, or
  // nobody at all — is one answer.
  if (!isActiveMemberOf(profile, companyId)) fail(CODE.NOT_FOUND, { what: 'member' })
  if (!isExternalRole(profile.role)) refuse({ reason: ASSIGNMENT_PROBLEM.ROLE })

  const before = currentAssignment(profile.projectIds)
  const resolved = resolveAssignmentChange(before.projectIds, change)
  if (!resolved.ok) refuse(resolved)
  const missing = await missingProjects(tx, db, companyId, resolved.projectIds)
  if (missing.length > 0) refuse({ reason: ASSIGNMENT_PROBLEM.NOT_FOUND, projectIds: missing })

  // A stored value that was not a clean list is rewritten even when the
  // resulting list equals what could be read from it.
  const changed = !before.sound || resolved.added.length > 0 || resolved.removed.length > 0
  return {
    profile, fileLinkSnap,
    result: {
      uid, companyId, email: profile.email ?? null, role: profile.role,
      before: before.projectIds, after: resolved.projectIds,
      added: resolved.added, removed: resolved.removed, changed,
      revocation: resolved.removed.length > 0,
    },
  }
}

export async function setMemberProjects(deps, { companyId, uid, change, dryRun = true, actor = OPERATOR, requestId = null, source = 'operator' }) {
  const { db, now } = deps
  if (!isValidId(companyId)) fail(CODE.INVALID_ARGUMENT, { field: 'companyId' })
  if (typeof uid !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(uid)) fail(CODE.INVALID_ARGUMENT, { field: 'uid' })
  // Refuse a malformed request before any read (the member's current list is
  // not needed to see that an id is malformed or repeated).
  const shape = resolveAssignmentChange([], change)
  if (!shape.ok) refuse(shape)

  if (dryRun) {
    const { result } = await db.runTransaction((tx) => planAssignment(tx, db, { companyId, uid, change }), { readOnly: true })
    return { ...result, dryRun: true, fileLinkRevocationSeq: null }
  }

  const nowDate = now()
  return withCompanyLock(db, companyId, nowDate, async (tx) => {
    const { profile, fileLinkSnap, result } = await planAssignment(tx, db, { companyId, uid, change })
    if (!result.changed) return { ...result, dryRun: false, fileLinkRevocationSeq: null }

    const ts = Timestamp.fromDate(nowDate)
    const fileLinkRevocationSeq = result.revocation
      ? requestRevocationInTx(tx, db, companyId, fileLinkSnap, { now: nowDate, actorUid: actor.uid, targetUid: uid, reason: REASON.ASSIGNMENT_REMOVED, requestId, source })
      : null
    tx.update(userRef(db, uid), { projectIds: result.after, updatedAt: ts, updatedBy: actor.uid })
    if (fileLinkRevocationSeq !== null) {
      // members/{uid} is history and listing, never a source of permissions:
      // the two fields below drive the Team page's "old file links" label.
      tx.set(membersCollection(db, companyId).doc(uid), {
        email: profile.email ?? null, name: profile.name ?? '', role: profile.role, status: MEMBER_STATUS.ACTIVE,
        updatedAt: ts, fileLinkRevocationSeq, fileAccessReducedAt: ts,
      }, { merge: true })
    }
    auditInTx(tx, db, companyId, {
      type: AUDIT.MEMBER_PROJECTS_CHANGED, actorUid: actor.uid, targetUid: uid, targetEmail: profile.email ?? null,
      before: { projectIds: result.before }, after: { projectIds: result.after }, requestId, source,
    }, nowDate)
    return { ...result, dryRun: false, fileLinkRevocationSeq }
  })
}

// The uid of the ACTIVE member of `companyId` with this email, for the script's
// `--email` form. Reads the authoritative users collection, never the members
// history. More than one match is refused: the operator must name the uid.
export async function findActiveMemberUid(db, companyId, rawEmail) {
  const email = normaliseEmail(rawEmail)
  if (!isValidEmail(email)) fail(CODE.INVALID_ARGUMENT, { field: 'email' })
  const snap = await db.collection('users').where('companyId', '==', companyId).where('email', '==', email).get()
  const uids = snap.docs.filter(d => isActiveMemberOf(d.data(), companyId)).map(d => d.id)
  if (uids.length === 0) fail(CODE.NOT_FOUND, { what: 'member' })
  if (uids.length > 1) fail(CODE.INVALID_ARGUMENT, { field: 'email', reason: 'ambiguous' })
  return uids[0]
}

// Assigned projects with no `projectDirectory` entry. The entry is what an
// external member's project list reads (ADR-83); without it the project is
// assigned and readable but absent from their list. A warning for the
// operator, never a refusal.
export async function projectsWithoutDirectoryEntry(db, companyId, projectIds) {
  if (projectIds.length === 0) return []
  const dir = companyRef(db, companyId).collection('projectDirectory')
  const snaps = await db.getAll(...projectIds.map(id => dir.doc(id)))
  return projectIds.filter((_, i) => !snaps[i].exists)
}
