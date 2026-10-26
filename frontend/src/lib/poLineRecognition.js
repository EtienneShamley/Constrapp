import { roundMoney, PO_COMMITTED_STATUSES } from './purchaseOrders'
import { claimedPoLines, recognisedClaimsByPoLine, CLAIM_APPROVED_STATUSES } from './progressClaims'
import {
  directInvoicedPoLines, postedDirectInvoicedByPoLine, invoicedClaimIds,
  SI_SOURCE, SI_COUNTING_STATUSES,
} from './supplierInvoices'

// ── PO-line recognition — one path per line (ADR-55) ─────────────────────────
//
// A PO line's cost reaches Actual by exactly ONE of two paths:
//
//   · a PROGRESS CLAIM on the line (certified, then invoiced from the claim), or
//   · a DIRECT supplier invoice against the line.
//
// The read-time derivation keys the claim→invoice hand-over on
// `progressClaimId` (supplierInvoices.invoicedClaimIds), so a DIRECT invoice —
// which carries no claim id — can never supersede a claim. If both paths are
// used on the same PO line, the approved claim stays in Actual AND the posted
// direct invoice is added to Actual: the same supply is counted twice, and
// Remaining Committed nets both off the line. Nothing in the data model can
// tell the two apart after the fact, so the only sound control is to keep the
// paths apart per line at authoring time and to surface every existing overlap
// for a human to reconcile.
//
// Everything here is CLIENT-ENFORCED (SECURITY.md → Deferred Control 34):
// Firestore rules cannot read sibling claims or invoices while validating a
// write, so a direct-SDK caller can still create the conflict. The detection
// below is what makes that visible (SHIELD check 4, condition E; the Supplier
// Invoices register notice). No record is ever reclassified, offset or
// rewritten — the figures stay as the documents say and the conflict is listed.

// ── Authoring guards ─────────────────────────────────────────────────────────

// Direct-invoice lines that land on a PO line a claim already occupies.
// `lineItems` are the invoice lines about to be saved (built, with
// `poLineIndex` and `amount`); only positive amounts conflict. Returns
// [{ poLineIndex, lineLabel, claimNumbers }] — empty when clean.
export function directInvoiceLineConflicts({ po, lineItems, progressClaims }) {
  if (!po?.id) return []
  const occupied = claimedPoLines(progressClaims ?? [], po.id)
  const conflicts = []
  for (const li of lineItems ?? []) {
    if (li?.poLineIndex == null || !((Number(li.amount) || 0) > 0)) continue
    const claimNumbers = occupied[li.poLineIndex]
    if (!claimNumbers?.length) continue
    conflicts.push({
      poLineIndex: li.poLineIndex,
      lineLabel: lineLabel(po, li.poLineIndex),
      claimNumbers: [...new Set(claimNumbers)],
    })
  }
  return conflicts
}

// Null when a direct invoice may be saved, otherwise the first blocking message.
export function directInvoiceConflictError(args) {
  const [first] = directInvoiceLineConflicts(args)
  if (!first) return null
  return `${first.lineLabel} is already being claimed through ${first.claimNumbers.join(', ')}. ` +
    'Invoice it from the approved claim instead, or leave this line at zero — a PO line is recognised through ' +
    'progress claims or direct invoices, never both.'
}

// Claim lines that land on a PO line a direct invoice already occupies.
// `lineItems` are the claim lines about to be saved (built, with `poLineIndex`
// and the cumulative `claimedToDate`); a line claimed at zero never conflicts.
// `excludeClaimId` is the draft being edited (its own stored lines are not
// "another" claim). Returns [{ poLineIndex, lineLabel, invoiceNumbers }].
export function claimLineConflicts({ po, lineItems, supplierInvoices }) {
  if (!po?.id) return []
  const occupied = directInvoicedPoLines(supplierInvoices ?? [], po.id)
  const conflicts = []
  for (const li of lineItems ?? []) {
    if (li?.poLineIndex == null) continue
    const claimed = (Number(li.claimedToDate) || 0) > 0 || (Number(li.claimedThisPeriod) || 0) > 0
    if (!claimed) continue
    const invoiceNumbers = occupied[li.poLineIndex]
    if (!invoiceNumbers?.length) continue
    conflicts.push({
      poLineIndex: li.poLineIndex,
      lineLabel: lineLabel(po, li.poLineIndex),
      invoiceNumbers: [...new Set(invoiceNumbers)],
    })
  }
  return conflicts
}

// Null when a claim may be saved, otherwise the first blocking message.
export function claimLineConflictError(args) {
  const [first] = claimLineConflicts(args)
  if (!first) return null
  return `${first.lineLabel} has already been invoiced directly (${first.invoiceNumbers.join(', ')}). ` +
    'Leave it at zero on this claim — a PO line is recognised through progress claims or direct invoices, never both.'
}

function lineLabel(po, idx) {
  const li = (po?.lineItems ?? [])[idx]
  const name = li?.costCodeName || li?.description || ''
  return `Line ${Number(idx) + 1}${name ? ` (${name})` : ''}`
}

// ── Detection of EXISTING overlaps ───────────────────────────────────────────
//
// A PO line is a mixed-mode conflict when, right now, Actual counts BOTH a
// posted/paid DIRECT invoice amount on it AND an approved claim amount on it
// that no posted claim-sourced invoice has superseded. Both amounts are the
// exact figures the Budget, Forecast and SHIELD derivations already use; the
// `overlap` is the smaller of the two — the most that can be a double count,
// stated as a bound, never as a correction. Drafts and cancelled records are
// not conflicts (they count nothing).
//
// Returns rows sorted by PO number then line, each:
//   { id, poId, poNumber, poStatus, poLineIndex, lineLabel, costCodeId,
//     costCodeName, description, lineTotal, directInvoiced, recognisedClaims,
//     overlap, invoiceNumbers, claimNumbers }
export function mixedModePoLineConflicts({ purchaseOrders = [], progressClaims = [], supplierInvoices = [] } = {}) {
  const pos = (purchaseOrders ?? []).filter(Boolean)
  const claims = (progressClaims ?? []).filter(Boolean)
  const invoices = (supplierInvoices ?? []).filter(Boolean)
  const directByLine = postedDirectInvoicedByPoLine(invoices)
  const recognisedByLine = recognisedClaimsByPoLine(claims, invoicedClaimIds(invoices))

  const rows = []
  for (const po of pos) {
    const direct = directByLine[po.id]
    const recognised = recognisedByLine[po.id]
    if (!direct || !recognised) continue
    for (const idxKey of Object.keys(direct)) {
      const idx = Number(idxKey)
      const directInvoiced = roundMoney(direct[idxKey] || 0)
      const recognisedClaims = roundMoney(recognised[idxKey] || 0)
      if (!(directInvoiced > 0) || !(recognisedClaims > 0)) continue
      const li = (po.lineItems ?? [])[idx] ?? {}
      rows.push({
        id: `${po.id}:${idx}`,
        poId: po.id,
        poNumber: po.poNumber || '',
        poStatus: po.status ?? null,
        committed: PO_COMMITTED_STATUSES.includes(po.status),
        poLineIndex: idx,
        lineLabel: lineLabel(po, idx),
        costCodeId: li.costCodeId || '',
        costCodeName: li.costCodeName || '',
        description: li.description || '',
        lineTotal: roundMoney(Number(li.lineTotal) || 0),
        directInvoiced,
        recognisedClaims,
        overlap: Math.min(directInvoiced, recognisedClaims),
        invoiceNumbers: directInvoiceNumbers(invoices, po.id, idx),
        claimNumbers: recognisedClaimNumbers(claims, invoices, po.id, idx),
      })
    }
  }
  rows.sort((a, b) => (a.poNumber.localeCompare(b.poNumber)) || (a.poLineIndex - b.poLineIndex))
  return rows
}

function directInvoiceNumbers(invoices, poId, idx) {
  const byPo = postedDirectInvoicedByPoLine(invoices)[poId] ?? {}
  if (!(byPo[idx] > 0)) return []
  const nums = []
  for (const inv of invoices) {
    if (inv.poId !== poId || inv.source !== SI_SOURCE.DIRECT_PO) continue
    if (!SI_COUNTING_STATUSES.includes(inv.status)) continue
    if ((inv.lineItems ?? []).some(li => li.poLineIndex === idx && (Number(li.amount) || 0) > 0)) {
      nums.push(inv.invoiceNumber || inv.id)
    }
  }
  return [...new Set(nums)]
}

function recognisedClaimNumbers(claims, invoices, poId, idx) {
  const superseded = invoicedClaimIds(invoices)
  const nums = []
  for (const cl of claims) {
    if (cl.poId !== poId || superseded.has(cl.id)) continue
    if (!CLAIM_APPROVED_STATUSES.includes(cl.status)) continue
    if ((cl.lineItems ?? []).some(li => li.poLineIndex === idx && (Number(li.approvedThisPeriod) || 0) > 0)) {
      nums.push(cl.claimNumber || cl.id)
    }
  }
  return [...new Set(nums)]
}

// Σ overlap across every conflicting line — the UPPER BOUND of cost that may be
// counted twice in Actual right now. A bound for a notice, never a figure that
// is subtracted from anything.
export function mixedModeOverlapTotal(conflicts) {
  return roundMoney((conflicts ?? []).reduce((sum, c) => sum + (Number(c.overlap) || 0), 0))
}
