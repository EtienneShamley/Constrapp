import { SI_STATUS, SI_SOURCE } from './supplierInvoices'
import { CLAIM_STATUS, CLAIM_INVOICE_LINK, claimInvoiceLink } from './progressClaims'

// ── Supplier invoices — the browser's error type and the claim-link review ───
//
// Since ADR-93 every supplier-invoice write (create, edit, approve, post,
// cancel, and the claim ↔ invoice link) is made by the trusted backend
// (functions/src/supplierFinance/; the browser calls it through
// lib/supplierFinanceActions.js). What stays here is what the pages still use:
// the error type the invoice and claim pages present, and the PURE
// classification of an approved claim's invoice link against the register
// (the claims tab and SHIELD check 4).
//
// The transactions the browser used to run under Firestore Rules (ADR-40 /
// ADR-68: create + claim link, cancel + unlink, link an existing invoice) are
// no longer production code; their exact write shapes are kept in
// tests/fixtures/legacyClientWrites.js only so the Rules suites can prove the
// rules now refuse them.

export const SI_WRITE_ERROR = {
  ALREADY_INVOICED:    'already_invoiced',
  LEGACY_UNRECONCILED: 'legacy_unreconciled',
  STALE:               'stale',
  MISSING:             'missing',
  INVALID:             'invalid',
  PERMISSION:          'permission',
  OFFLINE:             'offline',
  UNKNOWN:             'unknown',
}

export const SI_WRITE_ERROR_MESSAGES = {
  [SI_WRITE_ERROR.ALREADY_INVOICED]:    'This progress claim already has an active supplier invoice. Nothing was created — the linked invoice is shown instead.',
  [SI_WRITE_ERROR.LEGACY_UNRECONCILED]: 'This progress claim was approved before claim-to-invoice pairing and must be reconciled on the Progress Claims tab before it can be invoiced.',
  [SI_WRITE_ERROR.STALE]:               'This progress claim changed since you loaded it. Review the latest version and retry — your entries are kept.',
  [SI_WRITE_ERROR.MISSING]:             'The record no longer exists.',
  [SI_WRITE_ERROR.INVALID]:             'This change is not valid for the records as they stand.',
  [SI_WRITE_ERROR.PERMISSION]:          'You do not have permission to change supplier invoices on this project.',
  [SI_WRITE_ERROR.OFFLINE]:             'Could not reach the server. Check your connection and try again — nothing was saved.',
  [SI_WRITE_ERROR.UNKNOWN]:             'The change did not complete. Nothing was saved — try again.',
}

export class SupplierInvoiceWriteError extends Error {
  constructor(kind, message, extra = {}) {
    super(message ?? SI_WRITE_ERROR_MESSAGES[kind] ?? SI_WRITE_ERROR_MESSAGES[SI_WRITE_ERROR.UNKNOWN])
    this.name = 'SupplierInvoiceWriteError'
    this.kind = kind
    // ALREADY_INVOICED carries the id of the invoice the claim links, so the
    // caller can SHOW that record — it is never reported as "created".
    if (extra.linkedInvoiceId) this.linkedInvoiceId = extra.linkedInvoiceId
    if (extra.cause) this.cause = extra.cause
  }
}

const sameId = (a, b) => (a ?? null) === (b ?? null)

// ── Whether an approved claim may be linked to an existing invoice ──────────
//
// The eligibility test the claim-link review uses to say whether a claim's one
// active invoice is LINKABLE. The link itself is written only by the backend
// (`supplierInvoiceOperation` → link), which re-checks it on the server copies.
export const SI_ACTIVE_STATUSES = [SI_STATUS.DRAFT, SI_STATUS.APPROVED, SI_STATUS.POSTED]

export function existingInvoiceLinkError(claim, invoice) {
  if (!claim) return 'This progress claim no longer exists.'
  if (!invoice) return 'The supplier invoice no longer exists.'
  const name = claim.claimNumber || 'This progress claim'
  if (claim.status !== CLAIM_STATUS.APPROVED) return `${name} is not approved.`
  const link = claimInvoiceLink(claim)
  if (link.state === CLAIM_INVOICE_LINK.LINKED) return `${name} is already linked to a supplier invoice.`
  if (link.state !== CLAIM_INVOICE_LINK.LEGACY && link.state !== CLAIM_INVOICE_LINK.UNLINKED) return `${name} carries a malformed invoice link.`
  if (invoice.source !== SI_SOURCE.PROGRESS_CLAIM) return `${invoice.invoiceNumber || 'The invoice'} is not a claim-sourced invoice.`
  if (invoice.progressClaimId !== claim.id) return `${invoice.invoiceNumber || 'The invoice'} does not reference ${name}.`
  if (invoice.poId !== claim.poId) return `${invoice.invoiceNumber || 'The invoice'} is against a different purchase order than ${name}.`
  if (!sameId(invoice.supplierId, claim.supplierId)) return `${invoice.invoiceNumber || 'The invoice'} names a different supplier than ${name}.`
  if (!SI_ACTIVE_STATUSES.includes(invoice.status)) return `${invoice.invoiceNumber || 'The invoice'} is ${invoice.status} and reserves nothing.`
  return null
}

// ── Link reconciliation state (the claims tab and SHIELD check 4) ────────────
//
// What an approved claim's link says against the invoice register the client
// holds. Pure classification — nothing here is proof of absence: a register
// that is loading or failed must never reach this (the callers fail closed),
// and "no invoice" from a settled register is still only what the client
// could read. `null` issue means the link and the register agree.
export const CLAIM_LINK_ISSUE = {
  LEGACY_NO_INVOICE:        'legacy_no_invoice',         // key absent, no invoice at all — trusted reconciliation only
  LEGACY_CANCELLED_ONLY:    'legacy_cancelled_only',     // key absent, cancelled invoices only — trusted reconciliation only
  UNLINKED_ACTIVE_INVOICE:  'unlinked_active_invoice',   // no current link, exactly ONE active invoice — linkable (g)
  UNLINKED_DUPLICATES:      'unlinked_duplicates',       // no current link, several active invoices — blocked; condition D lists them
  LINKED_INVOICE_MISSING:   'linked_invoice_missing',    // the linked invoice is not on the register
  LINKED_INVOICE_CANCELLED: 'linked_invoice_cancelled',  // the linked invoice is cancelled (an unlink that never landed)
  LINKED_INVOICE_MISMATCH:  'linked_invoice_mismatch',   // the linked invoice names another claim / PO / supplier, or is not claim-sourced
  MALFORMED_LINK:           'malformed_link',            // the key holds something other than null or an id
}

export const CLAIM_LINK_ISSUE_LABELS = {
  [CLAIM_LINK_ISSUE.LEGACY_NO_INVOICE]:        'Approved before pairing — no invoice on the register; awaiting trusted reconciliation',
  [CLAIM_LINK_ISSUE.LEGACY_CANCELLED_ONLY]:    'Approved before pairing — only cancelled invoices on the register; awaiting trusted reconciliation',
  [CLAIM_LINK_ISSUE.UNLINKED_ACTIVE_INVOICE]:  'Active invoice not linked by its claim — link it on the Progress Claims tab',
  [CLAIM_LINK_ISSUE.UNLINKED_DUPLICATES]:      'More than one active invoice and no link — resolve the duplicates first',
  [CLAIM_LINK_ISSUE.LINKED_INVOICE_MISSING]:   'Linked invoice not found on the register',
  [CLAIM_LINK_ISSUE.LINKED_INVOICE_CANCELLED]: 'Linked invoice is cancelled',
  [CLAIM_LINK_ISSUE.LINKED_INVOICE_MISMATCH]:  'Linked invoice does not match the claim',
  [CLAIM_LINK_ISSUE.MALFORMED_LINK]:           'Malformed invoice link',
}

export function claimLinkReconciliation(claim, invoices = []) {
  const link = claimInvoiceLink(claim)
  const referencing = (invoices ?? []).filter(inv => inv && inv.progressClaimId === claim?.id)
  const active = referencing.filter(inv => SI_ACTIVE_STATUSES.includes(inv.status))
  const base = { state: link.state, invoiceId: link.invoiceId, activeInvoices: active, linkable: null, linkedInvoice: null, issue: null }
  if (link.state === CLAIM_INVOICE_LINK.MALFORMED) return { ...base, issue: CLAIM_LINK_ISSUE.MALFORMED_LINK }
  if (link.state === CLAIM_INVOICE_LINK.LINKED) {
    const inv = (invoices ?? []).find(i => i && i.id === link.invoiceId) ?? null
    if (!inv) return { ...base, issue: CLAIM_LINK_ISSUE.LINKED_INVOICE_MISSING }
    if (inv.status === SI_STATUS.CANCELLED) return { ...base, linkedInvoice: inv, issue: CLAIM_LINK_ISSUE.LINKED_INVOICE_CANCELLED }
    if (inv.source !== SI_SOURCE.PROGRESS_CLAIM || inv.progressClaimId !== claim.id || inv.poId !== claim.poId || !sameId(inv.supplierId, claim.supplierId)) {
      return { ...base, linkedInvoice: inv, issue: CLAIM_LINK_ISSUE.LINKED_INVOICE_MISMATCH }
    }
    return { ...base, linkedInvoice: inv }
  }
  // No current link: legacy (key absent) or new-format null.
  if (active.length > 1) return { ...base, issue: CLAIM_LINK_ISSUE.UNLINKED_DUPLICATES }
  if (active.length === 1) {
    const inv = active[0]
    const linkable = existingInvoiceLinkError(claim, inv) === null ? inv : null
    return { ...base, linkable, issue: linkable ? CLAIM_LINK_ISSUE.UNLINKED_ACTIVE_INVOICE : CLAIM_LINK_ISSUE.LINKED_INVOICE_MISMATCH }
  }
  if (link.state === CLAIM_INVOICE_LINK.LEGACY) {
    return { ...base, issue: referencing.length > 0 ? CLAIM_LINK_ISSUE.LEGACY_CANCELLED_ONLY : CLAIM_LINK_ISSUE.LEGACY_NO_INVOICE }
  }
  return base
}
