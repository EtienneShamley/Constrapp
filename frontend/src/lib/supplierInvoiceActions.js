import { SI_STATUS, SI_DOC_TYPE, SI_SOURCE, claimReconciliationError, invoiceTotals } from './supplierInvoices'
import { CLAIM_STATUS, CLAIM_INVOICE_LINK, claimInvoiceLink } from './progressClaims'
import { storedRevision, nextRevision } from './progressClaimActions'
import { roundMoney } from './purchaseOrders'

// ── Claim ↔ supplier-invoice SOURCE PAIRING (SHIELD 2A, ADR-68) ──────────────
//
// One approved progress claim reserves at most ONE active (draft / approved /
// posted) claim-sourced supplier invoice. The reservation is the claim's
// `supplierInvoiceId` backlink, written in the SAME transaction as the invoice
// (create) and cleared in the SAME transaction as its cancellation — and
// Firestore Rules pair the two halves through getAfter(), so a direct-SDK
// caller can create neither an unpaired claim-sourced invoice nor a dangling
// link. The claim document is the concurrency boundary: two creators are
// serialised on it, the loser re-reads a linked claim and gets
// ALREADY_INVOICED (or is refused by the rules against the winner's state).
// Nothing here is a recognition event — Actual still hands over from the claim
// to the invoice when the invoice POSTS (lib/supplierInvoices.js →
// invoicedClaimIds); no selector reads the link.
//
// Three transactions, on the lib/progressClaimActions.js convention (all reads
// before any write; the SDK is INJECTED so this module imports no Firebase
// code and the emulator suite exercises the real transactions against the
// real rules):
//
//   · runCreateSupplierInvoice — counter + invoice (+ claim link) (+ lock)
//   · runCancelSupplierInvoice — invoice cancel (+ claim unlink)
//   · runLinkExistingInvoice   — RECONCILE: a claim with no current link
//     records an EXISTING active invoice of its own (legacy claims predate
//     the link; an old tab's Stage-1 invoice left a new-format claim null)
//
// A LEGACY claim (no `supplierInvoiceId` KEY) is never invoiceable through the
// pairing until reconciled — rules cannot prove that no invoice exists, so
// there is deliberately NO path that sets an absent key to null (ADR-68).

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

export function supplierInvoiceWriteErrorKind(code) {
  switch (code) {
    case 'permission-denied':  return SI_WRITE_ERROR.PERMISSION
    case 'unavailable':
    case 'deadline-exceeded':  return SI_WRITE_ERROR.OFFLINE
    case 'not-found':          return SI_WRITE_ERROR.MISSING
    default:                   return SI_WRITE_ERROR.UNKNOWN
  }
}

const fail = (kind, message, extra) => ({ kind, message, ...extra })

// ── The documents ────────────────────────────────────────────────────────────

// The supplier invoice document exactly as hooks/useSupplierInvoices.jsx has
// always written it (ADR-40 shape: born draft, every lifecycle stamp null, the
// audit stamps on). `totals` is lib/supplierInvoices.js → invoiceTotals over
// the STORED lines; `now` is the injected serverTimestamp().
export function buildSupplierInvoiceDocument({
  invoiceNumber, source, supplierId, supplierName, poId, poNumber,
  progressClaimId, claimNumber, variationLineCount,
  supplierInvoiceNumber, invoiceDate, receivedDate, dueDate, paymentTerms,
  lineItems, totals, currency, notes, uid, now,
}) {
  return {
    invoiceNumber,
    supplierInvoiceNumber: supplierInvoiceNumber?.trim() || '',
    status:                SI_STATUS.DRAFT,
    docType:               SI_DOC_TYPE.INVOICE,
    source,

    // Supplier identity — snapshot from the PO/claim, never re-read.
    supplierId:   supplierId ?? null,
    supplierName: (supplierName || '').trim(),

    // Source references.
    poId:            poId ?? null,
    poNumber:        poNumber ?? null,
    progressClaimId: progressClaimId ?? null,
    claimNumber:     claimNumber ?? null,
    // ADR-63: how many stored lines are variation-origin (0 on a direct PO
    // invoice); rules bound it by the claim's and freeze it for life.
    variationLineCount,

    // Dates and terms.
    invoiceDate:  invoiceDate  || '',
    receivedDate: receivedDate || '',
    dueDate:      dueDate      || '',
    paymentTerms: paymentTerms ?? null,

    // Money — ex-GST canonical, per-line GST (see invoiceTotals).
    lineItems:      lineItems,
    retention:      totals.retention,
    retentionGst:   totals.retentionGst,
    retentionTotal: totals.retentionTotal,
    subtotal:       totals.subtotal,
    gstTotal:       totals.gstTotal,
    grossTotal:     totals.grossTotal,
    net:            totals.net,
    payableGst:     totals.payableGst,
    payableTotal:   totals.payableTotal,
    // Audit snapshot of the project currency at write time — never read for
    // display (the PROJECT currency is the authority).
    currency,
    revision:  1,

    notes: notes?.trim() || '',

    // Audit stamps — every one REQUIRED NULL at creation by rules (ADR-40).
    approvedAt:  null,
    approvedBy:  null,
    postedAt:    null,
    postedBy:    null,
    cancelledAt: null,
    cancelledBy: null,

    // ⚠️ paidAt is DEPRECATED IN PLACE (ADR-24): written null once, never
    // updated — payment state derives from posted Supplier Payments.
    // adjustsInvoiceId / attachments / externalRefs remain reserved.
    paidAt:           null,
    adjustsInvoiceId: null,
    attachments:      [],
    externalRefs:     {},

    createdAt: now,
    createdBy: uid,
    updatedAt: now,
    updatedBy: uid,
  }
}

// The claim LINK write (rules branch (e) on create, (g) on reconcile): the
// three link keys, the +1 revision and the audit stamps — nothing else.
export function claimLinkUpdate(live, { invoiceId, uid, now }) {
  return {
    supplierInvoiceId:       invoiceId,
    supplierInvoiceLinkedAt: now,
    supplierInvoiceLinkedBy: uid,
    revision:  nextRevision(live),
    updatedAt: now,
    updatedBy: uid,
  }
}

// The claim UNLINK write (rules branch (f), with the invoice's cancellation).
export function claimUnlinkUpdate(live, { uid, now }) {
  return {
    supplierInvoiceId:       null,
    supplierInvoiceLinkedAt: null,
    supplierInvoiceLinkedBy: null,
    revision:  nextRevision(live),
    updatedAt: now,
    updatedBy: uid,
  }
}

const sameId = (a, b) => (a ?? null) === (b ?? null)
const sameMoney = (a, b) => roundMoney(Number(a) || 0) === roundMoney(Number(b) || 0)

// The server copy of the claim, checked against the copy the user reviewed.
// Returns an outcome object on any problem, null when the claim can be linked
// to a new invoice carrying `invoice` (the identity the invoice will store).
export function claimPairingError(live, seen, invoice) {
  if (!live) return fail(SI_WRITE_ERROR.MISSING, 'This progress claim no longer exists.')
  const name = live.claimNumber || seen?.claimNumber || 'This progress claim'
  if (live.status !== CLAIM_STATUS.APPROVED) {
    return fail(SI_WRITE_ERROR.STALE, `${name} is no longer approved. Review the latest version and retry — your entries are kept.`)
  }
  const link = claimInvoiceLink(live)
  if (link.state === CLAIM_INVOICE_LINK.LINKED) {
    return fail(SI_WRITE_ERROR.ALREADY_INVOICED, undefined, { linkedInvoiceId: link.invoiceId })
  }
  if (link.state === CLAIM_INVOICE_LINK.LEGACY) return fail(SI_WRITE_ERROR.LEGACY_UNRECONCILED)
  if (link.state !== CLAIM_INVOICE_LINK.UNLINKED) {
    return fail(SI_WRITE_ERROR.INVALID, `${name} carries a malformed invoice link and cannot be invoiced until it is reviewed.`)
  }
  if (storedRevision(live) !== storedRevision(seen)) {
    return fail(SI_WRITE_ERROR.STALE, `${name} was changed by another user since you loaded it. Review the latest version and retry — your entries are kept.`)
  }
  // The identity the invoice will carry must be the claim's own (rules check
  // the same four on the server copy — this names the reason first).
  if (live.poId !== invoice.poId) {
    return fail(SI_WRITE_ERROR.INVALID, `${name} is a claim against ${live.poNumber || 'another purchase order'}, not ${invoice.poNumber || 'the selected one'}.`)
  }
  if (!sameId(live.supplierId, invoice.supplierId) || String(live.supplierName ?? '').trim() !== String(invoice.supplierName ?? '').trim()) {
    return fail(SI_WRITE_ERROR.INVALID, `${name} names a different supplier than this invoice.`)
  }
  if (live.claimNumber !== invoice.claimNumber) {
    return fail(SI_WRITE_ERROR.INVALID, `${name} is not the claim this invoice was built from.`)
  }
  // The certified figures the editor reconciled against must still be the
  // server's (approved money is frozen by rules, so a difference is a direct
  // write — STALE, never merged).
  const seenLines = Array.isArray(seen?.lineItems) ? seen.lineItems.length : null
  const liveLines = Array.isArray(live.lineItems) ? live.lineItems.length : null
  if (!sameMoney(live.approvedGst, seen?.approvedGst) || !sameMoney(live.approvedTotal, seen?.approvedTotal) || seenLines !== liveLines) {
    return fail(SI_WRITE_ERROR.STALE, `${name}'s certified figures on the server differ from the ones you reviewed. Review the latest version and retry.`)
  }
  return null
}

// ── Create ───────────────────────────────────────────────────────────────────
//
// `document` is everything buildSupplierInvoiceDocument needs except the
// number, the stamps and the totals (derived here over the STORED lines).
// `seenClaim` is the approved claim the editor reconciled against (null for a
// direct_po invoice); `refs.claimRef` must be given with it. `stageLock(tx)`
// is hooks/projectCurrencyLock.js → stageProjectCurrencyLock bound to the
// project (a read that returns the write callback), injected like the SDK.
export async function runCreateSupplierInvoice({
  db, refs, document, seenClaim = null, uid, runTransaction, serverTimestamp, stageLock, formatNumber,
}) {
  if (!uid) throw new SupplierInvoiceWriteError(SI_WRITE_ERROR.PERMISSION)
  const { counterRef, invoiceRef, claimRef = null } = refs
  const claimSourced = document.source === SI_SOURCE.PROGRESS_CLAIM
  if (claimSourced && (!seenClaim?.id || !claimRef)) {
    throw new SupplierInvoiceWriteError(SI_WRITE_ERROR.INVALID, 'Select the approved progress claim this invoice is raised from.')
  }
  const totals = invoiceTotals(document.lineItems, document.retention)

  let outcome
  try {
    outcome = await runTransaction(db, async (tx) => {
      // READS — all before any write.
      const counterSnap = await tx.get(counterRef)
      const next = counterSnap.exists() ? counterSnap.data().next : 1
      const commitLock = stageLock ? await stageLock(tx) : () => {}
      let liveClaim = null
      if (claimSourced) {
        const claimSnap = await tx.get(claimRef)
        liveClaim = claimSnap.exists() ? { id: claimSnap.id, ...claimSnap.data() } : null
        const pairingError = claimPairingError(liveClaim, seenClaim, document)
        if (pairingError) return pairingError
        // The existing reconciliation guard, against the SERVER certified
        // figures: the invoice must pay exactly the claim's GST and total.
        const reconcileError = claimReconciliationError(totals, { approvedGst: liveClaim.approvedGst, approvedTotal: liveClaim.approvedTotal })
        if (reconcileError) return fail(SI_WRITE_ERROR.INVALID, reconcileError)
      }

      // WRITES.
      const now = serverTimestamp()
      const invoiceNumber = formatNumber(next)
      tx.set(counterRef, { next: next + 1 }, { merge: true })
      tx.set(invoiceRef, buildSupplierInvoiceDocument({ ...document, invoiceNumber, totals, uid, now }))
      if (claimSourced) tx.update(claimRef, claimLinkUpdate(liveClaim, { invoiceId: invoiceRef.id, uid, now }))
      commitLock()
      return { kind: null, invoiceId: invoiceRef.id, invoiceNumber }
    })
  } catch (err) {
    if (err instanceof SupplierInvoiceWriteError) throw err
    throw new SupplierInvoiceWriteError(supplierInvoiceWriteErrorKind(err?.code), undefined, { cause: err })
  }
  if (outcome.kind) throw new SupplierInvoiceWriteError(outcome.kind, outcome.message, { linkedInvoiceId: outcome.linkedInvoiceId })
  return outcome
}

// ── Cancel ───────────────────────────────────────────────────────────────────
//
// draft | approved → cancelled. For a claim-sourced invoice whose claim links
// to IT, the claim is unlinked in the same commit (rules branch (f)); an
// invoice its claim does not link — legacy, or a claim that no longer exists
// — is cancelled exactly as before, with no link invented. Posted is terminal.
export async function runCancelSupplierInvoice({ db, invoiceRef, claimRef = null, seen, uid, runTransaction, serverTimestamp }) {
  if (!uid) throw new SupplierInvoiceWriteError(SI_WRITE_ERROR.PERMISSION)
  if (!seen?.id) throw new SupplierInvoiceWriteError(SI_WRITE_ERROR.MISSING)
  if (seen.status !== SI_STATUS.DRAFT && seen.status !== SI_STATUS.APPROVED) {
    throw new SupplierInvoiceWriteError(SI_WRITE_ERROR.INVALID, `Cannot cancel a ${seen.status} supplier invoice.`)
  }

  let outcome
  try {
    outcome = await runTransaction(db, async (tx) => {
      const invSnap = await tx.get(invoiceRef)
      if (!invSnap.exists()) return fail(SI_WRITE_ERROR.MISSING, 'This supplier invoice no longer exists.')
      const live = invSnap.data()
      if (live.status !== seen.status) {
        return fail(SI_WRITE_ERROR.STALE, `${live.invoiceNumber || 'This supplier invoice'} is now ${live.status}, not ${seen.status}. Review the latest version.`)
      }
      if (live.status !== SI_STATUS.DRAFT && live.status !== SI_STATUS.APPROVED) {
        return fail(SI_WRITE_ERROR.INVALID, `Cannot cancel a ${live.status} supplier invoice.`)
      }
      let liveClaim = null
      if (live.source === SI_SOURCE.PROGRESS_CLAIM && live.progressClaimId && claimRef) {
        const claimSnap = await tx.get(claimRef)
        if (claimSnap.exists()) liveClaim = claimSnap.data()
      }
      const now = serverTimestamp()
      const unlink = !!liveClaim && claimInvoiceLink(liveClaim).invoiceId === invoiceRef.id
      tx.update(invoiceRef, {
        status: SI_STATUS.CANCELLED, cancelledAt: now, cancelledBy: uid, updatedAt: now, updatedBy: uid,
      })
      if (unlink) tx.update(claimRef, claimUnlinkUpdate(liveClaim, { uid, now }))
      return { kind: null, unlinked: unlink }
    })
  } catch (err) {
    if (err instanceof SupplierInvoiceWriteError) throw err
    throw new SupplierInvoiceWriteError(supplierInvoiceWriteErrorKind(err?.code), undefined, { cause: err })
  }
  if (outcome.kind) throw new SupplierInvoiceWriteError(outcome.kind, outcome.message)
  return outcome
}

// ── Reconcile: link an EXISTING invoice ──────────────────────────────────────
//
// Verifies, on the SERVER copies, that the claim is approved, at the revision
// the user reviewed and currently unlinked (legacy key-absent or new-format
// null), and that the invoice is an ACTIVE claim-sourced invoice citing this
// claim, its PO and its supplier — then writes the link alone. Rules verify
// that one invoice too (branch (g)); neither can see its siblings, which is
// why the page offers this only from a settled, error-free register showing
// exactly one active invoice, and SHIELD lists the rest.
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

export async function runLinkExistingInvoice({ db, claimRef, invoiceRef, seenClaim, seenInvoice, uid, runTransaction, serverTimestamp }) {
  if (!uid) throw new SupplierInvoiceWriteError(SI_WRITE_ERROR.PERMISSION)
  if (!seenClaim?.id) throw new SupplierInvoiceWriteError(SI_WRITE_ERROR.MISSING, 'This progress claim no longer exists.')
  const preError = existingInvoiceLinkError({ ...seenClaim }, seenInvoice)
  if (preError) throw new SupplierInvoiceWriteError(SI_WRITE_ERROR.INVALID, preError)

  let outcome
  try {
    outcome = await runTransaction(db, async (tx) => {
      const claimSnap = await tx.get(claimRef)
      const liveClaim = claimSnap.exists() ? { id: claimSnap.id, ...claimSnap.data() } : null
      const invSnap = await tx.get(invoiceRef)
      const liveInvoice = invSnap.exists() ? { id: invSnap.id, ...invSnap.data() } : null
      if (!liveClaim) return fail(SI_WRITE_ERROR.MISSING, 'This progress claim no longer exists.')
      if (!liveInvoice) return fail(SI_WRITE_ERROR.MISSING, 'The supplier invoice no longer exists.')
      // A claim linked meanwhile is ALREADY_INVOICED (the link also moved its
      // revision, so this is checked before the stale test names it as a
      // mere change); any other disagreement on the server copies is INVALID.
      const error = existingInvoiceLinkError(liveClaim, liveInvoice)
      if (error) return fail(claimInvoiceLink(liveClaim).state === CLAIM_INVOICE_LINK.LINKED ? SI_WRITE_ERROR.ALREADY_INVOICED : SI_WRITE_ERROR.INVALID, error, { linkedInvoiceId: claimInvoiceLink(liveClaim).invoiceId })
      if (storedRevision(liveClaim) !== storedRevision(seenClaim)) {
        return fail(SI_WRITE_ERROR.STALE, `${liveClaim.claimNumber || 'This progress claim'} was changed by another user since you loaded it. Review the latest version and retry.`)
      }
      tx.update(claimRef, claimLinkUpdate(liveClaim, { invoiceId: invoiceRef.id, uid, now: serverTimestamp() }))
      return { kind: null, invoiceId: invoiceRef.id }
    })
  } catch (err) {
    if (err instanceof SupplierInvoiceWriteError) throw err
    throw new SupplierInvoiceWriteError(supplierInvoiceWriteErrorKind(err?.code), undefined, { cause: err })
  }
  if (outcome.kind) throw new SupplierInvoiceWriteError(outcome.kind, outcome.message, { linkedInvoiceId: outcome.linkedInvoiceId })
  return outcome
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
