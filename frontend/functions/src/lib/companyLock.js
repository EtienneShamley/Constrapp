import { FieldValue, Timestamp } from './firebaseAdmin.js'
import { isActiveAdminOf } from './membershipState.js'

// ── Company membership lock ──────────────────────────────────────────────────
//
// `companies/{c}/system/membership` is a single document every membership
// mutation READS first and WRITES last inside its transaction. Two concurrent
// mutations in the same company therefore conflict on that document and
// serialise, under pessimistic (Standard edition) and optimistic (Enterprise)
// concurrency alike. The last-admin count below is taken inside that same
// transaction, so "two admins demote each other at once" cannot leave zero.
//
// Firestore transactions require every read before the first write; `fn`
// receives the transaction and must follow that order.

export const companyRef = (db, companyId) => db.collection('companies').doc(companyId)
export const lockRef = (db, companyId) => companyRef(db, companyId).collection('system').doc('membership')
export const membersCollection = (db, companyId) => companyRef(db, companyId).collection('members')
export const invitationsCollection = (db, companyId) => companyRef(db, companyId).collection('invitations')
export const usersCollection = (db) => db.collection('users')

export async function withCompanyLock(db, companyId, now, fn) {
  return db.runTransaction(async (tx) => {
    const lockSnap = await tx.get(lockRef(db, companyId))
    const result = await fn(tx, { version: lockSnap.exists ? lockSnap.data().version ?? 0 : 0 })
    tx.set(lockRef(db, companyId), {
      version: FieldValue.increment(1),
      updatedAt: Timestamp.fromDate(now),
    }, { merge: true })
    return result
  })
}

// Active company_admins of a company, read INSIDE the transaction from the
// authoritative users collection (never from a maintained count). Legacy
// profiles without `status` count as active, exactly as the rules treat them.
export async function countActiveAdmins(tx, db, companyId) {
  const q = usersCollection(db).where('companyId', '==', companyId).where('role', '==', 'company_admin')
  const snap = await tx.get(q)
  return snap.docs.filter(d => isActiveAdminOf(d.data(), companyId)).length
}
