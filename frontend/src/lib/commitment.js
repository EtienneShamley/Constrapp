import { remainingCommittedByPoLine, remainingCommittedByCostCode, PO_STATUS, roundMoney } from './purchaseOrders'
import { recognisedClaimsByPoLine, recognisedClaimsByVariationLine } from './progressClaims'
import { postedInvoicedByPoLine, postedInvoicedByVariationLine, invoicedClaimIds } from './supplierInvoices'
import {
  appliedSupplierVariationAdjustments, remainingCommittedByVariationLine, remainingCommittedNewScopeByCostCode,
} from './variations'

// ── Remaining Committed — THE ONE combined derivation (ADR-55 · ADR-62 · ADR-63) ─
//
// "Committed" means ordered and not yet recognised as Actual. Since M3-B2 a
// commitment is made of TWO kinds of commitment line, each matured by the SAME
// ADR-55 nets (posted invoices on the line + approved claims on the line not
// yet superseded by a posted claim-sourced invoice):
//
//   · PO LINES — revised by applied existing-line supplier-variation
//     adjustments (lib/purchaseOrders.js → remainingCommittedByPoLine, ADR-62)
//   · COMMITTED NEW-SCOPE VARIATION LINES — positive NEW_SCOPE lines of
//     approved, applied, scope-committed supplier variations, each a line in
//     its own right with ceiling = its approved amount, on its own cost code
//     (lib/variations.js → remainingCommittedByVariationLine, ADR-63)
//
// Every consumer — Budget, Forecast (and through it Commercial, Overview, the
// Dashboard snapshot, Cash Flow and PULSE), SHIELD and the variation effect
// previews — composes the figure HERE, so there is exactly one formula, one
// hand-over set (`superseded` = invoicedClaimIds) and one adjustment map.
// Pure: reads the four registers it is given, writes nothing.
export function remainingCommitment({ purchaseOrders = [], progressClaims = [], supplierInvoices = [], variations = [] } = {}) {
  const pos = purchaseOrders ?? []
  const superseded = invoicedClaimIds(supplierInvoices ?? [])
  const invByPoLine  = postedInvoicedByPoLine(supplierInvoices ?? [])
  const recByPoLine  = recognisedClaimsByPoLine(progressClaims ?? [], superseded)
  const invByVarLine = postedInvoicedByVariationLine(supplierInvoices ?? [])
  const recByVarLine = recognisedClaimsByVariationLine(progressClaims ?? [], superseded)
  const adjustments  = appliedSupplierVariationAdjustments(variations ?? [], pos)

  const byPoLine = remainingCommittedByPoLine(pos, invByPoLine, recByPoLine, adjustments.byPoLine)
  const poByCostCode = remainingCommittedByCostCode(pos, invByPoLine, recByPoLine, adjustments.byPoLine)
  const byVariationLine = remainingCommittedByVariationLine(adjustments.newScopeLines, invByVarLine, recByVarLine)
  const newScopeByCostCode = remainingCommittedNewScopeByCostCode(adjustments.newScopeLines, invByVarLine, recByVarLine)

  const byCostCode = {}
  for (const cc of new Set([...Object.keys(poByCostCode), ...Object.keys(newScopeByCostCode)])) {
    const total = roundMoney((poByCostCode[cc] || 0) + (newScopeByCostCode[cc] || 0))
    if (total > 0) byCostCode[cc] = total
  }

  return {
    byCostCode, byPoLine, byVariationLine, poByCostCode, newScopeByCostCode,
    adjustments, superseded, invByPoLine, recByPoLine, invByVarLine, recByVarLine,
  }
}

// Closed-PO residual open commitment — the same composition restricted to
// CLOSED POs (a committed new-scope line follows its PO: with the register
// narrowed to closed POs, lines on a sent PO classify INVALID and count
// nothing). Flagged for QS judgement, never released.
export function closedResidualCommitment(sources = {}) {
  const closed = (sources.purchaseOrders ?? []).filter(po => po?.status === PO_STATUS.CLOSED)
  return remainingCommitment({ ...sources, purchaseOrders: closed })
}
