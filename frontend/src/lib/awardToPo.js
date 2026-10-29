import { TENDER_STATUS, BID_STATUS, assessBid } from './tenders'
import {
  PO_STATUS, PO_MAX_LINES, buildPoLineItem, validatePoDraft, poTotals, roundMoney,
} from './purchaseOrders'
import { PO_SUPPLIER_TYPES } from './contacts'

// ── Awarded Tender → Linked Draft PO (M3-A, ADR-61) — pure domain logic ──────
//
// Everything here is a plain function over the documents the hooks already
// subscribe to: the awarded package, its winning bid, the cost-code library,
// the contacts directory and the PO register. No Firestore, no React. The
// transaction that writes the result lives in lib/awardToPoActions.js; the
// document shape comes from lib/purchaseOrders.js → buildPurchaseOrderDocument,
// the SAME builder the manual editor uses.
//
// THE MAPPING. A bid line is an ex-GST lump sum against a cost code; a PO line
// is qty × rate. The only mapping that invents nothing is qty 1, blank unit,
// rate = the bid amount, so lineTotal == amount and the PO subtotal == the
// Awarded Bid Value exactly. GST is then the existing poTotals (flat 10%),
// which a tender never carried — GST enters the lifecycle at commitment.
//
// FAIL CLOSED. A proposal with any blocker is not raisable; a loading or
// failed source is "unknown", never "nothing linked" (ADR-24). Nothing here
// clamps, omits or transforms an amount the PO cannot represent — it blocks.

export const AWARD_PO_LINE_QTY  = 1
export const AWARD_PO_LINE_UNIT = ''

export const awardPoDescription = (pkg) =>
  [pkg?.tenderNumber, pkg?.name].filter(Boolean).join(' — ').trim()

// ── Link state (read-time, from the PO subscription) ─────────────────────────

// Every PO ever raised from this package, newest first — the cancelled ones
// included, because a cancelled PO keeps its source keys (history).
export function linkedPurchaseOrders(pkg, purchaseOrders) {
  if (!pkg?.id) return []
  return (purchaseOrders ?? [])
    .filter(po => po?.sourceTenderPackageId === pkg.id)
    .slice()
    .sort((a, b) => (toMillis(b.createdAt) - toMillis(a.createdAt)))
}

const toMillis = (ts) => {
  if (!ts) return 0
  if (typeof ts.toMillis === 'function') return ts.toMillis()
  if (typeof ts.seconds === 'number') return ts.seconds * 1000
  const n = new Date(ts).getTime()
  return Number.isFinite(n) ? n : 0
}

// The package's CURRENT linked PO (its back-link), or null.
export function currentLinkedPurchaseOrder(pkg, purchaseOrders) {
  if (!pkg?.raisedPoId) return null
  return (purchaseOrders ?? []).find(po => po?.id === pkg.raisedPoId) ?? null
}

export const RAISE_STATE = {
  NONE:      'none',       // never raised — raise permitted
  ACTIVE:    'active',     // a draft / sent / closed PO is linked — refuse
  CANCELLED: 'cancelled',  // the linked PO was cancelled — re-raise permitted
  UNKNOWN:   'unknown',    // the package names a PO the register does not show — refuse
}

export function raiseState(pkg, purchaseOrders) {
  if (!pkg?.raisedPoId) return RAISE_STATE.NONE
  const po = currentLinkedPurchaseOrder(pkg, purchaseOrders)
  if (!po) return RAISE_STATE.UNKNOWN
  return po.status === PO_STATUS.CANCELLED ? RAISE_STATE.CANCELLED : RAISE_STATE.ACTIVE
}

// ── Supplier resolution ──────────────────────────────────────────────────────

export const SUPPLIER_STATE = {
  OK:       'ok',
  MISSING:  'missing',   // no contact with the bid's id
  ARCHIVED: 'archived',  // contact.isActive === false
}

// The bid's bidder, as the directory shows it today. The PO snapshots the
// bid's FROZEN name (rules verify it against the bid), so a renamed contact
// is reported, never silently substituted.
export function resolveAwardSupplier(bid, contacts) {
  const contact = (contacts ?? []).find(c => c?.id === bid?.bidderContactId) ?? null
  if (!contact) return { contact: null, state: SUPPLIER_STATE.MISSING, typeOk: false, renamed: false }
  const types = contact.contactTypes ?? []
  return {
    contact,
    state:   contact.isActive === false ? SUPPLIER_STATE.ARCHIVED : SUPPLIER_STATE.OK,
    typeOk:  PO_SUPPLIER_TYPES.some(t => types.includes(t)),
    renamed: !!contact.displayName && contact.displayName !== bid?.bidderName,
  }
}

// ── Same-supplier POs (a WARNING, never proof of duplication) ────────────────

// Non-cancelled POs on the project to the awarded supplier that were NOT
// raised from this package. Shown so a manual PO raised before M3-A is not
// doubled up by accident; it cannot prove the two cover the same scope.
export function sameSupplierPurchaseOrders(pkg, bid, purchaseOrders) {
  if (!bid?.bidderContactId) return []
  return (purchaseOrders ?? []).filter(po =>
    po?.supplierId === bid.bidderContactId
    && po.status !== PO_STATUS.CANCELLED
    && po.sourceTenderPackageId !== pkg?.id,
  )
}

// ── Line mapping ─────────────────────────────────────────────────────────────

const isWholeCents = (n) => typeof n === 'number' && Number.isFinite(n) && roundMoney(n) === n

// One bid line → one PO form line → one stored PO line, through the SAME
// buildPoLineItem the editor uses (costCodeName re-snapshotted from the live
// library; '' when the code is unknown, which validatePoDraft then rejects).
export function mapBidLineToPoLine(bidLine, { costCodes = [] } = {}) {
  return buildPoLineItem({
    costCodeId:  bidLine?.costCodeId ?? '',
    description: bidLine?.description ?? '',
    qty:         String(AWARD_PO_LINE_QTY),
    unit:        AWARD_PO_LINE_UNIT,
    unitPrice:   bidLine?.amount == null ? '' : String(bidLine.amount),
  }, { costCodes })
}

// ── THE proposal ─────────────────────────────────────────────────────────────
//
// → {
//     ok, blockers: string[], warnings: string[],
//     supplierId, supplierName, description, notes, lineItems,
//     totals: { subtotal, gst, total }, awardedTotal (number | null),
//     exclusions, bidNotes, bidderRef, supplier: resolveAwardSupplier(),
//     linked: { state, current, history }, sameSupplier: PO[]
//   }
// `ok` is true only with ZERO blockers. Warnings never block.
export function buildAwardPurchaseOrderProposal({
  pkg, bid, costCodes = [], contacts = [], projectCurrency, purchaseOrders = [],
}) {
  const blockers = []
  const warnings = []

  // Source validity — the same gates the rules apply at create.
  if (!pkg) blockers.push('Select an awarded tender package.')
  else if (pkg.status !== TENDER_STATUS.AWARDED) blockers.push('Only an awarded package can raise a purchase order.')
  if (!bid) blockers.push('The awarded bid could not be found — it is missing from the bid register.')
  else {
    if (pkg && pkg.awardedBidId !== bid.id) blockers.push('This bid is not the bid the package was awarded to.')
    if (pkg && bid.tenderPackageId !== pkg.id) blockers.push('The awarded bid belongs to a different package.')
    if (bid.status !== BID_STATUS.RECEIVED) blockers.push('The awarded bid is void and cannot be raised.')
  }

  const assessment = pkg && bid ? assessBid(bid, pkg) : { valid: false, total: null, problems: [] }
  if (pkg && bid && !assessment.valid) {
    blockers.push(`The awarded bid fails the validity gate: ${assessment.problems.join(' ') || 'malformed line items.'}`)
  }

  // Currency — the PO is pinned to the project's resolved currency; the bid
  // carries an audit snapshot. They can differ only through a direct write.
  if (bid && projectCurrency && bid.currency && bid.currency !== projectCurrency) {
    blockers.push(`The bid was priced in ${bid.currency} but the project reports in ${projectCurrency} — a currency is a label, never a conversion.`)
  }

  // Supplier — identity comes from the bid; the directory must still resolve it.
  const supplier = resolveAwardSupplier(bid, contacts)
  if (bid) {
    if (supplier.state === SUPPLIER_STATE.MISSING) blockers.push('The awarded supplier no longer exists in Contacts.')
    else if (supplier.state === SUPPLIER_STATE.ARCHIVED) blockers.push(`${bid.bidderName || 'The awarded supplier'} is archived in Contacts — reactivate the contact to raise this purchase order.`)
    else if (!supplier.typeOk) warnings.push(`${bid.bidderName || 'The awarded supplier'} is no longer marked as a supplier or subcontractor in Contacts.`)
    if (supplier.state === SUPPLIER_STATE.OK && supplier.renamed) {
      warnings.push(`The contact is now named "${supplier.contact.displayName}"; the purchase order will carry the awarded name "${bid.bidderName}".`)
    }
  }

  // Lines — one per bid line, in bid order, repeated cost codes kept.
  const bidLines = Array.isArray(bid?.lineItems) ? bid.lineItems : []
  const lineItems = bidLines.map(li => mapBidLineToPoLine(li, { costCodes }))
  if (assessment.valid) {
    const missing = []
    const inactive = []
    const notCents = []
    bidLines.forEach((li, idx) => {
      const cc = costCodes.find(c => c?.id === li.costCodeId)
      if (!cc) missing.push(`line ${idx + 1} (${li.costCodeName || li.costCodeId})`)
      else if (cc.isActive === false) inactive.push(cc.code ? `${cc.code} — ${cc.name}` : li.costCodeName)
      if (!isWholeCents(li.amount)) notCents.push(`line ${idx + 1}`)
    })
    if (missing.length) blockers.push(`The cost code on ${missing.join(', ')} no longer exists in the library — raise this purchase order manually or restore the code.`)
    if (inactive.length) warnings.push(`Inactive cost code${inactive.length > 1 ? 's' : ''} carried from the bid: ${[...new Set(inactive)].join(', ')} — re-code the line in the draft if needed.`)
    if (notCents.length) blockers.push(`The bid amount on ${notCents.join(', ')} is not a whole-cent value and cannot be carried into a purchase order unchanged.`)
    if (lineItems.length > PO_MAX_LINES) blockers.push(`A purchase order can carry at most ${PO_MAX_LINES} lines.`)
    const draftError = validatePoDraft({ lineItems, costCodes })
    if (draftError && !missing.length) blockers.push(draftError)
  }

  const totals = poTotals(lineItems)
  // The promise of the mapping: subtotal == Awarded Bid Value, to the cent.
  if (assessment.valid && blockers.length === 0 && totals.subtotal !== assessment.total) {
    blockers.push('The proposed purchase order subtotal does not equal the awarded bid value — nothing was created.')
  }

  // Link state — one current PO per award; re-raise only after cancellation.
  const state = raiseState(pkg, purchaseOrders)
  const current = currentLinkedPurchaseOrder(pkg, purchaseOrders)
  if (state === RAISE_STATE.ACTIVE) {
    blockers.push(`${current.poNumber} has already been raised from this award and is ${current.status}. Cancel it before raising another.`)
  } else if (state === RAISE_STATE.UNKNOWN) {
    blockers.push('This award already names a purchase order that could not be found in the register — reload before raising another.')
  }

  const sameSupplier = sameSupplierPurchaseOrders(pkg, bid, purchaseOrders)
  if (sameSupplier.length) {
    warnings.push(`${sameSupplier.length === 1 ? 'A purchase order' : `${sameSupplier.length} purchase orders`} to this supplier already exist${sameSupplier.length === 1 ? 's' : ''} on this project (${sameSupplier.map(po => po.poNumber).join(', ')}). This may or may not cover the same scope — Constrapp cannot tell.`)
  }

  return {
    ok: blockers.length === 0,
    blockers,
    warnings,
    supplierId:   bid?.bidderContactId ?? null,
    supplierName: bid?.bidderName ?? '',
    description:  awardPoDescription(pkg),
    notes:        '',
    lineItems,
    totals,
    awardedTotal: assessment.total,
    exclusions:   bid?.exclusions || '',
    bidNotes:     bid?.notes || '',
    bidderRef:    bid?.bidderRef || '',
    supplier,
    linked: { state, current, history: linkedPurchaseOrders(pkg, purchaseOrders) },
    sameSupplier,
  }
}

// ── The UI gate (fail-closed over subscription state) ────────────────────────
//
// → { allowed, pending, reason }. `pending` while any source is still loading;
// `reason` names the first problem. The proposal's own blockers are included so
// the button and the dialog agree.
export function raisePurchaseOrderGate({
  pkg, bid, costCodes, contacts, projectCurrency, purchaseOrders,
  purchaseOrdersLoading = false, purchaseOrdersError = false,
  bidsLoading = false, bidsError = false,
  contactsLoading = false, contactsError = false,
  costCodesLoading = false, costCodesError = false,
}) {
  if (pkg?.status !== TENDER_STATUS.AWARDED) {
    return { allowed: false, pending: false, reason: 'Only an awarded package can raise a purchase order.' }
  }
  if (purchaseOrdersLoading || bidsLoading || contactsLoading || costCodesLoading) {
    return { allowed: false, pending: true, reason: 'Loading purchase orders, bids, contacts and cost codes…' }
  }
  if (purchaseOrdersError) return { allowed: false, pending: false, reason: 'Purchase orders could not be loaded — whether one was already raised is unknown, so raising is disabled.' }
  if (bidsError)           return { allowed: false, pending: false, reason: 'Bids could not be loaded — the awarded bid is unavailable, so raising is disabled.' }
  if (contactsError)       return { allowed: false, pending: false, reason: 'Contacts could not be loaded — the supplier cannot be resolved, so raising is disabled.' }
  if (costCodesError)      return { allowed: false, pending: false, reason: 'Cost codes could not be loaded — the lines cannot be mapped, so raising is disabled.' }
  const proposal = buildAwardPurchaseOrderProposal({ pkg, bid, costCodes, contacts, projectCurrency, purchaseOrders })
  if (!proposal.ok) return { allowed: false, pending: false, reason: proposal.blockers[0] }
  return { allowed: true, pending: false, reason: null }
}
