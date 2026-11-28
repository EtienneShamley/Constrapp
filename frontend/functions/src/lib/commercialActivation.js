import { CODE, fail } from './errors.js'

// ── Phase 2 commercial activation, per company (final release batch) ─────────
//
//   companies/{companyId}.commercialCompletionEnabled === true
//
// A boolean written ONLY by the operator tool
// (scripts/set-commercial-completion.mjs, one audit event per change); no
// client can write it (the company update Rule does not list it). Every Phase 2
// financial operation — trusted variations, progress claims, supplier
// invoices, supplier settlement, client refunds and receipt applications, the
// void of an issued client invoice, original-contract-value corrections,
// estimating, and the BOQ transfer recorded as an estimate's handover — acts
// for a company only when it is true:
//
//   · checked FIRST, outside any transaction (`assertCommercialActivated`), so
//     an inactive company never gets a historical baseline written;
//   · checked AGAIN inside the operation's own transaction
//     (`requireCommercialActivationInTx`), next to the caller's membership, so
//     a deactivation and an operation in flight are ordered by Firestore: the
//     operation either commits before the deactivation or is refused after it.
//
// The global switches (params.js) stay above it as emergency brakes and are
// checked before it. STRICT: only the boolean `true` activates. Activation is
// not approval segregation (approvalPolicy.js) and never enables it. Phase 1
// operations (receipts, client credit notes and retention releases, the Final
// Account, the BOQ transfer without an estimate) are not gated by it.

export const COMMERCIAL_ACTIVATION_FIELD = 'commercialCompletionEnabled'

export const commercialActivated = (company) => company?.[COMMERCIAL_ACTIVATION_FIELD] === true

const companyRef = (db, companyId) => db.collection('companies').doc(companyId)

export async function assertCommercialActivated(db, companyId) {
  const snap = await companyRef(db, companyId).get()
  if (!snap.exists) fail(CODE.NOT_FOUND)
  if (!commercialActivated(snap.data())) fail(CODE.COMMERCIAL_NOT_ACTIVATED)
}

export async function requireCommercialActivationInTx(tx, db, companyId) {
  const snap = await tx.get(companyRef(db, companyId))
  if (!snap.exists) fail(CODE.NOT_FOUND)
  if (!commercialActivated(snap.data())) fail(CODE.COMMERCIAL_NOT_ACTIVATED)
}
