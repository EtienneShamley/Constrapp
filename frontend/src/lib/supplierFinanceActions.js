// ── Browser side of the supplier-finance callables (ADR-93 / ADR-94) ─────────
//
// Three callables, each `{ operation, request }` (functions/src/index.js):
//   progressClaimOperation · supplierInvoiceOperation · supplierSettlementOperation
// The hooks build the request from what the editor holds — authored content
// and identifiers only — and this module calls, and turns every failure into a
// SupplierFinanceError whose `kind` the pages already know how to present
// (stale, invalid, permission, offline, missing, unavailable, uncertain).
//
// ⚠️ OUTCOMES. A typed refusal (details.code) is CERTAIN: nothing was
// written. A transport failure without one is UNCERTAIN: the operation may or
// may not have committed. Every operation is idempotent by state, so the user
// is told to reload and look before retrying — never that nothing happened.

import { COMMERCIAL_NOT_ACTIVATED_CODE, COMMERCIAL_MAINTENANCE_TEXT } from './commercialActivation'

export const SF_CALLABLE = {
  CLAIM:      'progressClaimOperation',
  INVOICE:    'supplierInvoiceOperation',
  SETTLEMENT: 'supplierSettlementOperation',
}

// Longer than the function may run (120 s), so the server's answer arrives first.
export const SF_CALL_TIMEOUT_MS = 130000

export const SF_ERROR = {
  STALE:       'stale',
  INVALID:     'invalid',
  PERMISSION:  'permission',
  OFFLINE:     'offline',
  MISSING:     'missing',
  UNAVAILABLE: 'unavailable',
  UNCERTAIN:   'uncertain',
}

export const SF_ERROR_MESSAGES = {
  [SF_ERROR.STALE]:       'This document changed since you loaded it. Review the latest version and retry — your entries are kept.',
  [SF_ERROR.INVALID]:     'This change is not valid for the document as it stands. Nothing was saved.',
  [SF_ERROR.PERMISSION]:  'You do not have permission to make this change. Nothing was saved.',
  [SF_ERROR.OFFLINE]:     'The server is busy or could not be reached. Nothing was saved — try again in a moment.',
  [SF_ERROR.MISSING]:     'This document no longer exists.',
  [SF_ERROR.UNAVAILABLE]: 'This action is not available yet. Nothing was saved.',
  [SF_ERROR.UNCERTAIN]:   'The server did not confirm the outcome. Reload the page and check whether the change was saved before trying again.',
}

export class SupplierFinanceError extends Error {
  constructor(kind, message, cause) {
    super(message ?? SF_ERROR_MESSAGES[kind] ?? SF_ERROR_MESSAGES[SF_ERROR.UNCERTAIN])
    this.name = 'SupplierFinanceError'
    this.kind = kind
    this.code = cause?.details?.code ?? null
    this.details = cause?.details ?? null
    if (cause) this.cause = cause
  }
}

// details.code → [kind, show the server's own sentence?, fixed message?]
const TYPED = {
  'supplier-finance-disabled':             [SF_ERROR.UNAVAILABLE, false],
  // Phase 2 company activation (lib/commercialActivation.js): CERTAIN — the
  // company is not yet switched over; nothing was written.
  [COMMERCIAL_NOT_ACTIVATED_CODE]:         [SF_ERROR.UNAVAILABLE, false, COMMERCIAL_MAINTENANCE_TEXT],
  'supplier-finance-forbidden':            [SF_ERROR.PERMISSION,  false],
  'no-membership':                         [SF_ERROR.PERMISSION,  false],
  'membership-inactive':                   [SF_ERROR.PERMISSION,  false],
  'unauthenticated':                       [SF_ERROR.PERMISSION,  true],
  'not-found':                             [SF_ERROR.MISSING,     false],
  'invalid-argument':                      [SF_ERROR.INVALID,     false],
  'supplier-finance-invalid':              [SF_ERROR.INVALID,     true],
  'supplier-finance-id-conflict':          [SF_ERROR.INVALID,     true],
  'supplier-finance-stale':                [SF_ERROR.STALE,       true],
  'supplier-finance-figures-inconsistent': [SF_ERROR.INVALID,     true],
  'supplier-finance-figures-moved':        [SF_ERROR.STALE,       true],
  'supplier-finance-cap-exceeded':         [SF_ERROR.INVALID,     true],
  'supplier-finance-dependency':           [SF_ERROR.INVALID,     true],
  'supplier-finance-open-claim':           [SF_ERROR.INVALID,     true],
  'supplier-finance-already-invoiced':     [SF_ERROR.STALE,       true],
  'supplier-finance-legacy-claim':         [SF_ERROR.INVALID,     true],
  'supplier-finance-not-linked':           [SF_ERROR.INVALID,     true],
  'supplier-finance-ledger-inconsistent':  [SF_ERROR.INVALID,     true],
  'supplier-finance-baseline-invalid':     [SF_ERROR.INVALID,     true],
  'supplier-finance-future-dated':         [SF_ERROR.INVALID,     true],
  'supplier-finance-unsupported-record':   [SF_ERROR.INVALID,     true],
  'supplier-finance-out-of-range':         [SF_ERROR.INVALID,     true],
  'approval-segregation-required':         [SF_ERROR.PERMISSION,  true],
  'supplier-finance-busy':                 [SF_ERROR.OFFLINE,     true],
}

// Untyped failures whose outcome is nonetheless certain — answered before the
// handler could run.
const CERTAIN_TRANSPORT = {
  'unauthenticated':   [SF_ERROR.PERMISSION,  'Your session has ended or this browser could not be verified. Nothing was saved — reload the page, sign in and try again.'],
  'permission-denied': [SF_ERROR.PERMISSION,  undefined],
  'not-found':         [SF_ERROR.UNAVAILABLE, 'This action is not available on the server yet. Nothing was saved.'],
  'invalid-argument':  [SF_ERROR.INVALID,     undefined],
}

export function describeSupplierFinanceFailure(err) {
  if (err instanceof SupplierFinanceError) return err
  const typed = TYPED[err?.details?.code]
  if (typed) {
    const message = typed[1] && typeof err?.message === 'string' && err.message.length > 0 ? err.message : typed[2]
    return new SupplierFinanceError(typed[0], message, err)
  }
  const code = String(err?.code ?? '').replace(/^functions\//, '')
  const certain = CERTAIN_TRANSPORT[code]
  if (certain) return new SupplierFinanceError(certain[0], certain[1], err)
  return new SupplierFinanceError(SF_ERROR.UNCERTAIN, undefined, err)
}

// Calls one operation. `call(name, data)` is the injected transport (the
// hooks pass httpsCallable; tests pass a stub). Resolves to the operation's
// own answer, which always carries a boolean `alreadyApplied`.
export async function runSupplierFinance(call, name, operation, request) {
  let result
  try {
    result = await call(name, { operation, request })
  } catch (err) {
    throw describeSupplierFinanceFailure(err)
  }
  if (!result || typeof result !== 'object' || typeof result.alreadyApplied !== 'boolean') {
    throw new SupplierFinanceError(SF_ERROR.UNCERTAIN)
  }
  return result
}

// ── Request builders (authored content and identifiers only) ─────────────────

const text = (v) => (typeof v === 'string' ? v : '')
const amountOf = (v) => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : NaN
}

// A claim line's source identity, as the create request names it.
export function claimLineRequest(li) {
  const variation = typeof li?.variationId === 'string' && li.variationId.length > 0
  return {
    poLineIndex: variation ? null : li?.poLineIndex,
    variationId: variation ? li.variationId : null,
    variationLineIndex: variation ? li.variationLineIndex : null,
    claimedToDate: Number(li?.claimedToDate) || 0,
  }
}

export const claimHeaderRequest = ({ periodEnding, claimRef, notes, retention }) => ({
  periodEnding: text(periodEnding), claimRef: text(claimRef).trim(), notes: text(notes).trim(), retention: amountOf(retention || 0),
})

// The index of a claim line matching an invoice line's source identity.
export function claimLineIndexOf(claim, line) {
  return (claim?.lineItems ?? []).findIndex(cl => (typeof line?.variationId === 'string' && line.variationId
    ? cl.variationId === line.variationId && cl.variationLineIndex === line.variationLineIndex
    : !cl.variationId && cl.poLineIndex === line?.poLineIndex))
}
