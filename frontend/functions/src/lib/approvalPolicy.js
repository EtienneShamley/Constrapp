import { CODE, fail } from './errors.js'

// ── Approval segregation (maker-checker) — ADR-96, Phase 2 step 6 ───────────
//
// ONE server-written policy document per company:
//
//   companies/{companyId}/approvalPolicy/current
//     { segregationEnabled: boolean, version, changedAt, changedBy, reason,
//       previous: { segregationEnabled, version } | null }
//
// Absent ⇒ DISABLED (the default, D4): every established workflow is
// preserved, and every approval records — in its audit event — whether the
// approver was also the creator, an editor or the submitter (single-person
// approval stays visible). Firestore Rules let a member READ the document and
// no client WRITE it; it is changed only by the operator tool
// (scripts/set-approval-policy.mjs), which records the old and new value, the
// actor, the time and the reason, and refuses to ENABLE segregation unless the
// company has at least two active members who hold approval authority (D5).
//
// ENABLED ⇒ the approver must be an INDEPENDENT active member (D4): not the
// document's CREATOR, not its LAST MATERIAL DRAFT EDITOR, not the user who
// SUBMITTED the reviewed revision. An earlier editor whose content has since
// been materially re-prepared by someone else is not excluded: that person is
// reviewing another member's revision. There is no administrator exception.
//
//   lastMaterialEditBy   written ONLY by the trusted backend: the creator on
//                        create, and the saving user on a draft edit that
//                        changes anything outside the document type's short
//                        list of non-financial text fields (`cosmetic`). A
//                        cosmetic edit keeps the stamp it found — so a
//                        colleague's edit of a note can never replace, and so
//                        hide, the material editor.
//   draftEditors         every user who saved the draft (bounded) — AUDIT
//                        provenance only; it excludes nobody.
// A document without the stamp (created by a client before the backend owned
// it, or still written by a client under Rules) falls back to `updatedBy`, its
// last editor of any kind.
//
// If no independent approver exists the approval fails closed with a reason;
// it is never silently allowed and the policy is never silently disabled (D5).
// Revoking a member is never blocked by this policy.
//
// The guard runs INSIDE the operation's transaction: the policy and the
// document are read in it, so a policy change, an edit or a membership change
// racing the approval is ordered against it (the membership itself is read in
// the same transaction by every operation).

export const approvalPolicyRef = (db, companyId) => db.collection('companies').doc(companyId).collection('approvalPolicy').doc('current')

// The uids excluded from approving a document (D4).
export function preparers(doc) {
  const lastMaterial = typeof doc?.lastMaterialEditBy === 'string' && doc.lastMaterialEditBy.length > 0 ? doc.lastMaterialEditBy : doc?.updatedBy
  const out = new Set()
  for (const uid of [doc?.createdBy, doc?.submittedBy, lastMaterial]) {
    if (typeof uid === 'string' && uid.length > 0) out.add(uid)
  }
  return out
}

export function independenceOf(doc, uid) {
  const excluded = preparers(doc)
  return {
    isCreator: doc?.createdBy === uid,
    isSubmitter: doc?.submittedBy === uid,
    isLastMaterialEditor: excluded.has(uid) && doc?.createdBy !== uid && doc?.submittedBy !== uid,
    wasEarlierEditor: !excluded.has(uid) && Array.isArray(doc?.draftEditors) && doc.draftEditors.includes(uid),
    independent: !excluded.has(uid),
  }
}

// A guard for one approval: `read(tx, scope)` inside the transaction, then
// `check(doc)` before any write, then `record()` for the audit event.
export function segregationGuard(db, uid, { label = 'document' } = {}) {
  let policy = null
  let enabled = false
  let assessed = null
  return {
    async read(tx, scope) {
      const snap = await tx.get(approvalPolicyRef(db, scope.companyId))
      policy = snap.exists ? snap.data() : null
      enabled = policy?.segregationEnabled === true
    },
    check(doc) {
      assessed = independenceOf(doc, uid)
      if (enabled && !assessed.independent) {
        fail(CODE.APPROVAL_SEGREGATION, {
          message: `Approval segregation is enabled for this company: this ${label} must be approved by another authorised member — not by its creator, the last person who materially edited its draft, or its submitter. If no other approver is available, an administrator must restore one, or the policy must be changed through an authorised, audited request.`,
          ...assessed,
        })
      }
    },
    record() {
      return { policyEnabled: enabled, policyVersion: policy?.version ?? null, ...(assessed ?? {}) }
    },
  }
}

export const DRAFT_EDITORS_MAX = 50

const stamps = ['revision', 'updatedAt', 'updatedBy', 'draftEditors', 'lastMaterialEditBy']
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

// Whether a draft update changes anything other than the stamps and the
// document type's `cosmetic` (non-financial text) fields.
export function isMaterialEdit(live, update, cosmetic = []) {
  return Object.keys(update ?? {}).some(k => !stamps.includes(k) && !cosmetic.includes(k) && !same(live?.[k], update[k]))
}

// The provenance fields a CREATE writes.
export const createdEditorStamp = (uid) => ({ draftEditors: [uid], lastMaterialEditBy: uid })

// The provenance fields a DRAFT EDIT writes: the audit list (bounded; order
// kept) and the last material editor — the saving user when the edit is
// material, otherwise the stamp already held (for a document that never had
// one, its last editor so far).
export function editorStamp(live, uid, update, cosmetic = []) {
  const list = Array.isArray(live?.draftEditors) ? live.draftEditors.filter(u => typeof u === 'string') : (typeof live?.updatedBy === 'string' ? [live.updatedBy] : [])
  if (!list.includes(uid)) list.push(uid)
  const held = typeof live?.lastMaterialEditBy === 'string' && live.lastMaterialEditBy.length > 0 ? live.lastMaterialEditBy : (typeof live?.updatedBy === 'string' ? live.updatedBy : live?.createdBy ?? uid)
  return { draftEditors: list.slice(-DRAFT_EDITORS_MAX), lastMaterialEditBy: isMaterialEdit(live, update, cosmetic) ? uid : held }
}

// ── Enabling the policy (D5) ─────────────────────────────────────────────────
// The strictest segregated workflow (approved budget versions, adjustments,
// the Final Account) is open to company_admin and project_manager only, so
// enabling segregation needs two ACTIVE members in those roles. Checked when
// enabling (scripts/set-approval-policy.mjs); never when removing a member.
export const ELIGIBLE_APPROVER_ROLES = ['company_admin', 'project_manager']
export const MIN_ELIGIBLE_APPROVERS = 2
export const eligibleApprovers = (members) =>
  (members ?? []).filter(m => m && m.status !== 'deactivated' && m.status !== 'removed' && typeof m.companyId === 'string' && ELIGIBLE_APPROVER_ROLES.includes(m.role))
