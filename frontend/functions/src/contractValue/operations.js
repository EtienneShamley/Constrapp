import { FieldValue } from '../lib/firebaseAdmin.js'
import { CODE, fail } from '../lib/errors.js'
import { userRef, assertActiveRole } from '../lib/authz.js'
import { requireCommercialActivationInTx } from '../lib/commercialActivation.js'
import { AUDIT, auditInTx } from '../lib/audit.js'
import { isValidId } from '../lib/validation.js'
import { segregationGuard } from '../lib/approvalPolicy.js'

// ── Original contract value protection (G5) — ADR-96, Phase 2 step 6 ────────
//
// The ORIGINAL CONTRACT VALUE lives on the project's commercial baseline
// (`commercial/baseline.originalContractValue`, ADR-20). Initial setup is a
// browser write, as before. Once the baseline exists, Firestore Rules refuse
// any client change to the value (and to the four provenance keys below): it
// changes ONLY through this controlled, audited correction process:
//
//   contractValueRevisions/{revisionId}
//     kind 'correction' · status proposed → approved | withdrawn
//     fromValue (the value the proposer saw) · toValue · reason
//     confirmsNotAVariation: true — a correction fixes the BASELINE (a value
//       entered wrongly, or an amendment to the executed contract sum); a
//       change of scope or price after award is a CLIENT VARIATION and is
//       recorded as one, never as a correction
//     proposedAt/By · approvedAt/By · withdrawnAt/By · reasons
//
// propose  — one open proposal per project; refused if the baseline is
//            missing, if `fromValue` is not the stored value (stale), or if
//            the value would not change.
// approve  — the proposal is still open and the stored value is still its
//            `fromValue` (stale otherwise); APPROVAL SEGREGATION applies (the
//            proposer is the preparer). Writes the new value onto the baseline
//            with its provenance (`originalContractValueVersion` + 1,
//            revisedAt/By, revisionId), the proposal approved, one audit event.
// withdraw — an open proposal is withdrawn; nothing else changes.
//
// The figure every surface reads — contract revenue, forecasts, gross profit,
// margin, Dashboard, Portfolio, Commercial Reports, Final Account readiness —
// is the baseline value itself, so an approved correction reaches all of them
// at once. An APPROVED Final Account revision keeps the figures it recorded.
// The history of every value is the approved revisions in order.

export const CONTRACT_VALUE_ROLES = ['company_admin', 'project_manager', 'qs']
export const REASON_MAX = 2000
export const MAX_CONTRACT_CENTS = 99_999_999_999_999
const GRPC_ABORTED = 10

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const exactKeys = (d, keys) => isObject(d) && Object.keys(d).length === keys.length && keys.every(k => k in d)
const isMoney = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && Math.round(v * 100) / 100 === v && Math.round(v * 100) <= MAX_CONTRACT_CENTS
const cents = (v) => Math.round(v * 100)

const KEYS = {
  propose: ['projectId', 'revisionId', 'fromValue', 'toValue', 'reason', 'confirmsNotAVariation'],
  approve: ['projectId', 'revisionId'],
  withdraw: ['projectId', 'revisionId', 'reason'],
}

export function parseContractValueOperation(data) {
  if (!exactKeys(data, ['operation', 'request']) || !Object.prototype.hasOwnProperty.call(KEYS, data.operation)) fail(CODE.INVALID_ARGUMENT, { field: 'envelope' })
  const r = data.request
  if (!exactKeys(r, KEYS[data.operation])) fail(CODE.INVALID_ARGUMENT, { field: 'keys' })
  if (!isValidId(r.projectId) || !isValidId(r.revisionId)) fail(CODE.INVALID_ARGUMENT, { field: 'ids' })
  if (data.operation === 'propose') {
    if (!isMoney(r.fromValue) || !isMoney(r.toValue)) fail(CODE.INVALID_ARGUMENT, { field: 'value' })
    if (r.confirmsNotAVariation !== true) fail(CODE.INVALID_ARGUMENT, { field: 'confirmsNotAVariation' })
  }
  if ('reason' in r && (typeof r.reason !== 'string' || r.reason.trim().length < 10 || r.reason.length > REASON_MAX)) fail(CODE.INVALID_ARGUMENT, { field: 'reason' })
  return { operation: data.operation, input: { ...r } }
}

async function scope(tx, db, uid, projectId) {
  const profileSnap = await tx.get(userRef(db, uid))
  const profile = assertActiveRole(profileSnap.exists ? profileSnap.data() : null, CONTRACT_VALUE_ROLES, CODE.NO_MEMBERSHIP)
  await requireCommercialActivationInTx(tx, db, profile.companyId)
  const companyRef = db.collection('companies').doc(profile.companyId)
  const projectRef = companyRef.collection('projects').doc(projectId)
  // `commercial/contractValueState` is server-only (no Rule matches it): it
  // names the ONE open proposal, so two concurrent proposals contend on it.
  return {
    companyId: profile.companyId, projectRef, baselineRef: projectRef.collection('commercial').doc('baseline'),
    stateRef: projectRef.collection('commercial').doc('contractValueState'), revisions: projectRef.collection('contractValueRevisions'),
  }
}

async function guarded(db, body) {
  try {
    return await db.runTransaction(body, { maxAttempts: 5 })
  } catch (err) {
    if (!err?.details?.code && err?.code === GRPC_ABORTED) fail(CODE.CONTRACT_VALUE_STALE)
    throw err
  }
}

export async function proposeContractValue(deps, { uid, input, requestId = null }) {
  const { db, now } = deps
  return guarded(db, async (tx) => {
    const s = await scope(tx, db, uid, input.projectId)
    const ref = s.revisions.doc(input.revisionId)
    const [projectSnap, baselineSnap, revisionSnap, stateSnap] = await tx.getAll(s.projectRef, s.baselineRef, ref, s.stateRef)
    if (!projectSnap.exists) fail(CODE.NOT_FOUND)
    if (revisionSnap.exists) {
      if (revisionSnap.data().proposedBy !== uid) fail(CODE.CONTRACT_VALUE_INVALID, { message: 'A different proposal already uses this identifier.' })
      return { alreadyApplied: true }
    }
    const baseline = baselineSnap.exists ? baselineSnap.data() : null
    if (!baseline || typeof baseline.originalContractValue !== 'number') fail(CODE.CONTRACT_VALUE_INVALID, { message: 'This project has no original contract value yet — set it up on the commercial baseline first.' })
    if (stateSnap.exists && typeof stateSnap.data().pendingRevisionId === 'string') fail(CODE.CONTRACT_VALUE_INVALID, { message: 'A correction of the original contract value is already awaiting approval. Approve or withdraw it first.' })
    if (cents(baseline.originalContractValue) !== cents(input.fromValue)) fail(CODE.CONTRACT_VALUE_STALE)
    if (cents(input.toValue) === cents(input.fromValue)) fail(CODE.CONTRACT_VALUE_INVALID, { message: 'The proposed value is the current value.' })
    const stamp = FieldValue.serverTimestamp()
    const doc = {
      kind: 'correction', status: 'proposed', fromValue: input.fromValue, toValue: input.toValue, reason: input.reason.trim(),
      confirmsNotAVariation: true, fromVersion: Number.isSafeInteger(baseline.originalContractValueVersion) ? baseline.originalContractValueVersion : 0,
      proposedAt: stamp, proposedBy: uid, createdBy: uid, approvedAt: null, approvedBy: null, withdrawnAt: null, withdrawnBy: null, withdrawReason: '',
    }
    tx.create(ref, doc)
    tx.set(s.stateRef, { pendingRevisionId: input.revisionId, updatedAt: stamp }, { merge: true })
    auditInTx(tx, db, s.companyId, { type: AUDIT.CONTRACT_VALUE_PROPOSED, actorUid: uid, requestId, before: { valueCents: cents(input.fromValue) }, after: { projectId: input.projectId, revisionId: input.revisionId, valueCents: cents(input.toValue), reason: doc.reason } }, now())
    return { alreadyApplied: false }
  })
}

export async function approveContractValue(deps, { uid, input, requestId = null }) {
  const { db, now } = deps
  return guarded(db, async (tx) => {
    const s = await scope(tx, db, uid, input.projectId)
    const ref = s.revisions.doc(input.revisionId)
    const [revisionSnap, baselineSnap] = await tx.getAll(ref, s.baselineRef)
    const segregation = segregationGuard(db, uid, { label: 'correction of the original contract value' })
    await segregation.read(tx, s)
    if (!revisionSnap.exists) fail(CODE.NOT_FOUND)
    const rev = revisionSnap.data()
    if (rev.status === 'approved' && rev.approvedBy === uid) return { alreadyApplied: true }
    if (rev.status !== 'proposed') fail(CODE.CONTRACT_VALUE_INVALID, { message: `This proposal is ${rev.status}.` })
    const baseline = baselineSnap.exists ? baselineSnap.data() : null
    const version = Number.isSafeInteger(baseline?.originalContractValueVersion) ? baseline.originalContractValueVersion : 0
    if (!baseline || cents(baseline.originalContractValue) !== cents(rev.fromValue) || version !== rev.fromVersion) fail(CODE.CONTRACT_VALUE_STALE)
    segregation.check({ createdBy: rev.proposedBy, lastMaterialEditBy: rev.proposedBy })
    const stamp = FieldValue.serverTimestamp()
    tx.update(s.baselineRef, {
      originalContractValue: rev.toValue, originalContractValueVersion: version + 1,
      originalContractValueRevisedAt: stamp, originalContractValueRevisedBy: uid, originalContractValueRevisionId: input.revisionId,
      updatedAt: stamp, updatedBy: uid,
    })
    tx.update(ref, { status: 'approved', approvedAt: stamp, approvedBy: uid, toVersion: version + 1 })
    tx.set(s.stateRef, { pendingRevisionId: null, updatedAt: stamp }, { merge: true })
    auditInTx(tx, db, s.companyId, {
      type: AUDIT.CONTRACT_VALUE_APPROVED, actorUid: uid, requestId, before: { valueCents: cents(rev.fromValue), version },
      after: { projectId: input.projectId, revisionId: input.revisionId, valueCents: cents(rev.toValue), version: version + 1, proposedBy: rev.proposedBy, segregation: segregation.record() },
    }, now())
    return { alreadyApplied: false }
  })
}

export async function withdrawContractValue(deps, { uid, input, requestId = null }) {
  const { db, now } = deps
  return guarded(db, async (tx) => {
    const s = await scope(tx, db, uid, input.projectId)
    const ref = s.revisions.doc(input.revisionId)
    const revisionSnap = await tx.get(ref)
    if (!revisionSnap.exists) fail(CODE.NOT_FOUND)
    const rev = revisionSnap.data()
    if (rev.status === 'withdrawn' && rev.withdrawnBy === uid) return { alreadyApplied: true }
    if (rev.status !== 'proposed') fail(CODE.CONTRACT_VALUE_INVALID, { message: `This proposal is ${rev.status}.` })
    const stamp = FieldValue.serverTimestamp()
    tx.update(ref, { status: 'withdrawn', withdrawnAt: stamp, withdrawnBy: uid, withdrawReason: input.reason.trim() })
    tx.set(s.stateRef, { pendingRevisionId: null, updatedAt: stamp }, { merge: true })
    auditInTx(tx, db, s.companyId, { type: AUDIT.CONTRACT_VALUE_WITHDRAWN, actorUid: uid, requestId, before: { status: 'proposed' }, after: { projectId: input.projectId, revisionId: input.revisionId } }, now())
    return { alreadyApplied: false }
  })
}

export const CONTRACT_VALUE_OPERATIONS = { propose: proposeContractValue, approve: approveContractValue, withdraw: withdrawContractValue }
