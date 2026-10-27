import { PO_STATUS, PO_STATUS_LABELS, canTransition } from './purchaseOrders'
import { CLAIM_STATUS, CLAIM_STATUS_LABELS } from './progressClaims'
import { SI_STATUS, SI_STATUS_LABELS } from './supplierInvoices'
import { VARIATION_TYPE, VARIATION_STATUS, VARIATION_STATUS_LABELS } from './variations'

// ── PO cancellation safety (ADR-57, M2-B1) ───────────────────────────────────
//
// A purchase order with surviving financial activity may not be cancelled.
// Cancelling drops the PO out of Committed entirely, but any claim or supplier
// invoice raised against it keeps counting (Actual recognises an approved
// claim and a posted invoice regardless of the PO's status), so the cost would
// detach from the commitment it was certified against. SHIELD check 4
// conditions A and B exist to list exactly that state after the fact; this
// guard stops the app from creating it.
//
// THE STRICT SAFE POLICY. A claim blocks unless it is `rejected`; an invoice
// blocks unless it is `cancelled`; a SUPPLIER variation whose scalar `poId`
// names the PO blocks unless it is `rejected` or `withdrawn` (ADR-57 review
// finding: an approved supplier variation is commitment exposure against the
// PO — `approvedSupplierVariationsByCostCode` does not filter by PO status, so
// the figure would survive the cancel detached from any live commitment, and
// no SHIELD condition lists that state). Drafts block too: a draft claim,
// invoice or variation is work in progress against this commitment, and
// cancelling the PO underneath it would strand a document the one-open-claim
// rule and the pickers can no longer reach. Every terminal state is reached
// through the records' own lifecycles — nothing here deletes, rejects,
// withdraws, cancels or otherwise mutates a linked record. A supplier
// variation raised in "manual" mode (`poId: null`) and every client variation
// never link to a PO and never block.
//
// Everything here is CLIENT-ENFORCED (docs/SECURITY.md → Deferred Control 35).
// Firestore rules have no list, query or count, so no rule can see whether a
// claim or invoice references the PO being cancelled; a direct-SDK caller can
// still cancel it. The hook runs this guard twice: against the live
// subscriptions before asking the user to confirm, and again inside the
// transaction against the server copies of every linked record it knew about
// (lib/purchaseOrderActions.js). A record created between the subscription
// snapshot and the commit is not seen — that window is the documented gap.

export const PO_CANCEL_BLOCKER_KIND = { CLAIM: 'claim', INVOICE: 'invoice', VARIATION: 'variation' }

// Variation statuses that no longer carry exposure against the PO.
const VARIATION_NON_BLOCKING = [VARIATION_STATUS.REJECTED, VARIATION_STATUS.WITHDRAWN]

// Linked records that keep the PO alive. Pure, order-preserving (claims,
// invoices, then supplier variations), never mutates its inputs. Documents
// with no `poId` or another PO's id are ignored.
export function poCancellationBlockers(poId, { progressClaims = [], supplierInvoices = [], variations = [] } = {}) {
  if (!poId) return []
  const blockers = []
  for (const c of progressClaims ?? []) {
    if (c?.poId !== poId || c.status === CLAIM_STATUS.REJECTED) continue
    blockers.push({
      kind: PO_CANCEL_BLOCKER_KIND.CLAIM, id: c.id ?? null, number: c.claimNumber || '',
      status: c.status ?? '', statusLabel: CLAIM_STATUS_LABELS[c.status] ?? String(c.status ?? ''),
    })
  }
  for (const inv of supplierInvoices ?? []) {
    if (inv?.poId !== poId || inv.status === SI_STATUS.CANCELLED) continue
    blockers.push({
      kind: PO_CANCEL_BLOCKER_KIND.INVOICE, id: inv.id ?? null, number: inv.invoiceNumber || '',
      status: inv.status ?? '', statusLabel: SI_STATUS_LABELS[inv.status] ?? String(inv.status ?? ''),
    })
  }
  for (const v of variations ?? []) {
    if (v?.poId !== poId || v.variationType !== VARIATION_TYPE.SUPPLIER || VARIATION_NON_BLOCKING.includes(v.status)) continue
    blockers.push({
      kind: PO_CANCEL_BLOCKER_KIND.VARIATION, id: v.id ?? null, number: v.variationNumber || '',
      status: v.status ?? '', statusLabel: VARIATION_STATUS_LABELS[v.status] ?? String(v.status ?? ''),
    })
  }
  return blockers
}

const describe = (rows) => rows.map(r => `${r.number || r.id || '?'} (${r.statusLabel || r.status || 'unknown'})`).join(', ')

// One sentence the UI and the hook both show, built from the blockers only.
export function poCancellationReason(poNumber, blockers) {
  const claims     = blockers.filter(b => b.kind === PO_CANCEL_BLOCKER_KIND.CLAIM)
  const invoices   = blockers.filter(b => b.kind === PO_CANCEL_BLOCKER_KIND.INVOICE)
  const variations = blockers.filter(b => b.kind === PO_CANCEL_BLOCKER_KIND.VARIATION)
  const parts = []
  if (claims.length)     parts.push(`${claims.length} progress claim${claims.length === 1 ? '' : 's'} — ${describe(claims)}`)
  if (invoices.length)   parts.push(`${invoices.length} supplier invoice${invoices.length === 1 ? '' : 's'} — ${describe(invoices)}`)
  if (variations.length) parts.push(`${variations.length} supplier variation${variations.length === 1 ? '' : 's'} — ${describe(variations)}`)
  const remedy = [
    claims.length     ? 'reject the claims' : null,
    invoices.length   ? 'cancel the invoices' : null,
    variations.length ? 'reject or withdraw the supplier variations' : null,
  ].filter(Boolean)
  const remedyText = remedy.length > 1 ? `${remedy.slice(0, -1).join(', ')} and ${remedy[remedy.length - 1]}` : (remedy[0] ?? '')
  return `${poNumber || 'This purchase order'} cannot be cancelled: it has ${parts.join(', ')}. ` +
         `${remedyText.charAt(0).toUpperCase()}${remedyText.slice(1)} first — cancelling the PO never changes them.`
}

// The full pre-write guard over LIVE subscription state. Fails CLOSED: while
// any of the three dependencies is loading, or when any read failed, the answer is
// "not allowed" with `pending` set for the loading case — an unavailable
// register is never read as "no linked records" (ADR-24).
//
// Returns { allowed, pending, reason, blockers }.
export function poCancellationGuard(po, linked) {
  if (!linked || typeof linked !== 'object') {
    return {
      allowed: false, pending: false, blockers: [],
      reason: 'Linked progress claims and supplier invoices must be loaded before a purchase order can be cancelled.',
    }
  }
  const {
    progressClaims = [], progressClaimsLoading = false, progressClaimsError = false,
    supplierInvoices = [], supplierInvoicesLoading = false, supplierInvoicesError = false,
    variations = [], variationsLoading = false, variationsError = false,
  } = linked
  if (!po?.id) {
    return { allowed: false, pending: false, blockers: [], reason: 'This purchase order no longer exists.' }
  }
  if (!canTransition(po.status, PO_STATUS.CANCELLED)) {
    const label = PO_STATUS_LABELS[po.status] ?? String(po.status ?? 'unknown')
    return { allowed: false, pending: false, blockers: [], reason: `A ${label} purchase order cannot be cancelled.` }
  }
  if (progressClaimsLoading || supplierInvoicesLoading || variationsLoading) {
    return { allowed: false, pending: true, blockers: [], reason: 'Checking linked claims, supplier invoices and variations…' }
  }
  if (progressClaimsError || supplierInvoicesError || variationsError) {
    return {
      allowed: false, pending: false, blockers: [],
      reason: 'Linked progress claims, supplier invoices or variations could not be loaded, so this purchase order cannot be cancelled right now. Reload and try again.',
    }
  }
  const blockers = poCancellationBlockers(po.id, { progressClaims, supplierInvoices, variations })
  if (blockers.length > 0) {
    return { allowed: false, pending: false, blockers, reason: poCancellationReason(po.poNumber, blockers) }
  }
  return { allowed: true, pending: false, blockers: [], reason: null }
}
