import { CODE, fail } from '../lib/errors.js'
import * as calc from '../generated/supplierFinanceCalc.js'

// ── Supplier-finance callables — the input contracts (ADR-93 / ADR-94) ───────
//
// Each callable takes `{ operation, request }`. The request carries AUTHORED
// CONTENT AND IDENTIFIERS ONLY: no GST, no total, no number, no currency, no
// status, no stamp, no calculation version, no snapshot and no companyId — an
// unexpected key refuses the whole request. Shapes, bounds and exact key sets
// are the domain modules' own (the generated bundle), so the browser refuses
// the same request before it is sent.

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

function envelope(data, operations) {
  if (!isObject(data) || Object.keys(data).length !== 2 || !('operation' in data) || !('request' in data)) fail(CODE.INVALID_ARGUMENT, { field: 'envelope' })
  if (typeof data.operation !== 'string' || !Object.prototype.hasOwnProperty.call(operations, data.operation)) fail(CODE.INVALID_ARGUMENT, { field: 'operation' })
  const problem = operations[data.operation](data.request)
  if (problem) fail(CODE.INVALID_ARGUMENT, { field: problem })
  return { operation: data.operation, input: structuredClone(data.request) }
}

export const CLAIM_OPERATIONS = {
  create: calc.createClaimRequestProblem,
  update: calc.updateClaimRequestProblem,
  approve: calc.approveClaimRequestProblem,
  reject: calc.rejectClaimRequestProblem,
}

export const INVOICE_OPERATIONS = {
  create: calc.createInvoiceRequestProblem,
  update: calc.updateInvoiceRequestProblem,
  approve: calc.invoiceTransitionRequestProblem,
  post: calc.invoiceTransitionRequestProblem,
  cancel: calc.invoiceTransitionRequestProblem,
  link: calc.linkInvoiceRequestProblem,
}

export const SETTLEMENT_OPERATIONS = {
  saveCredit: calc.creditDraftRequestProblem,
  postCredit: calc.settlementPostRequestProblem,
  voidCredit: calc.settlementVoidRequestProblem,
  saveRelease: calc.releaseDraftRequestProblem,
  postRelease: calc.settlementPostRequestProblem,
  voidRelease: calc.settlementVoidRequestProblem,
  savePayment: calc.paymentDraftRequestProblem,
  postPayment: calc.settlementPostRequestProblem,
  voidPayment: calc.settlementVoidRequestProblem,
}

export const parseClaimOperation = (data) => envelope(data, CLAIM_OPERATIONS)
export const parseInvoiceOperation = (data) => envelope(data, INVOICE_OPERATIONS)
export const parseSettlementOperation = (data) => envelope(data, SETTLEMENT_OPERATIONS)
