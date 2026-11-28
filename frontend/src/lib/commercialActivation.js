// ── Phase 2 commercial activation, per company (final release batch) ─────────
//
// The Phase 2 financial programme — trusted variations, progress claims,
// supplier invoices, supplier settlement (credit notes, retention releases,
// payments), client refunds and receipt applications, the void of an issued
// client invoice, original-contract-value corrections and estimating — acts for
// a company only when its company document carries
//
//     companies/{companyId}.commercialCompletionEnabled === true
//
// a boolean written ONLY by the operator tool
// (functions/scripts/set-commercial-completion.mjs, audited), never by a client
// (the company update Rule does not list it). The global switches stay above it
// as emergency brakes: a switch that is off refuses an activated company too.
//
// ⚠️ UX ONLY. Nothing here enforces anything. The trusted backend refuses every
// Phase 2 operation for a company that is not activated
// (`commercial-completion-not-activated`), checked again inside the operation's
// own transaction. These helpers only keep the browser from offering what would
// be refused and explain why.
//
// Once the final Firestore Rules are published, the OLD client write paths of
// these registers are closed for EVERY company. A company that is not yet
// activated therefore has these registers READ-ONLY — the maintenance
// restriction — until it is activated. Its existing records stay visible.
//
// STRICT: only the boolean `true` activates. A company that is still loading,
// could not be read, or does not carry the field is NOT activated.
//
// Not to be confused with approval segregation (maker-checker), an optional
// and separate company policy (companies/{c}/approvalPolicy/current): activation
// never enables it.

export const COMMERCIAL_ACTIVATION_FIELD = 'commercialCompletionEnabled'

export const COMMERCIAL_NOT_ACTIVATED_CODE = 'commercial-completion-not-activated'

export const commercialCompletionActivated = (company) => company?.[COMMERCIAL_ACTIVATION_FIELD] === true

export const COMMERCIAL_MAINTENANCE_TITLE = 'Read-only during the commercial upgrade'

export const COMMERCIAL_MAINTENANCE_TEXT =
  'Variations, progress claims, supplier invoices, credit notes, retention releases, supplier payments, '
  + 'client refunds and receipt applications, client invoice voids, contract-value corrections and estimates '
  + 'are being moved to server-checked processing. Until your company is switched over, these records can be '
  + 'viewed but not created or changed. Nothing already recorded is affected. Contact Constrap support if this '
  + 'blocks urgent work.'

// ── Pure decisions the pages share (UX ONLY) ─────────────────────────────────
//
// ⚠️ THIS MODULE IMPORTS NOTHING. Variation, supplier-finance and other
// modules reach it, and some of them are bundled for the trusted backend
// (scripts/build-*-bundle.mjs): an import here would change those generated
// bundles. The two client-invoice statuses below are therefore literals, pinned
// equal to lib/clientInvoices.js → CI_STATUS by the unit suite.

// Whether a callable failure is the server's activation refusal — a CERTAIN
// refusal: the operation was refused before anything was written.
export const isCommercialNotActivated = (err) => err?.details?.code === COMMERCIAL_NOT_ACTIVATED_CODE

// What a page shows and offers, from the company document and its loading
// flags. The profile is waited for as well, because the company provider is
// idle (no company, not loading) until the profile has resolved.
//
//   loading      the answer is not known yet: offer NO Phase 2 write, but do
//                not show the maintenance notice either (no flash)
//   activated    strictly `commercialCompletionEnabled === true`
//   writable     the Phase 2 write actions may be offered
//   maintenance  the read-only notice is shown
export function commercialActivationState(company, { companyLoading = false, profileLoading = false } = {}) {
  const loading = companyLoading === true || profileLoading === true
  const activated = !loading && commercialCompletionActivated(company)
  return { loading, activated, writable: activated, maintenance: !loading && !activated }
}

// A client invoice's Void action. A DRAFT invoice is voided by the browser
// under the Rules (Phase 1) and stays available to every company; an ISSUED
// invoice is voided only by the trusted `voidClientInvoice` (Phase 2, D8) and
// is offered only to an activated company. Any other status: never.
export const CLIENT_INVOICE_VOID_STATUS = { DRAFT: 'draft', ISSUED: 'issued' }
export function clientInvoiceVoidOffered(status, state) {
  if (status === CLIENT_INVOICE_VOID_STATUS.DRAFT) return true
  if (status === CLIENT_INVOICE_VOID_STATUS.ISSUED) return state?.writable === true
  return false
}

// The message a page shows for a failure of a Phase 2 call whose module has
// no mapper of its own (the contract-value corrections): the maintenance text
// for the activation refusal, `otherwise` for anything else (unchanged).
export const commercialFailureMessage = (err, otherwise) =>
  (isCommercialNotActivated(err) ? COMMERCIAL_MAINTENANCE_TEXT : otherwise)
