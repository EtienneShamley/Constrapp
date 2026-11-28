// ── Browser side of `estimateOperation` (ADR-97) ─────────────────────────────
//
// One callable, `{ operation, request }` (functions/src/estimating):
//   build · approve · discard · setComponents
// The hook builds the request — identifiers, guards and authored settings
// only, never a quantity, rate, amount or price — and this module calls
// through an INJECTED `call` (so it imports no Firebase code) and turns every
// failure into an EstimateError.
//
// ⚠️ OUTCOMES. A typed refusal (details.code) is CERTAIN: nothing was changed
// by that operation. A transport failure without one is UNCERTAIN: it may or
// may not have completed. Every operation is idempotent by state — a repeat of
// the same request is answered "already applied" — so the user is told to
// look before retrying, never that nothing happened.

import { COMMERCIAL_NOT_ACTIVATED_CODE, COMMERCIAL_MAINTENANCE_TEXT } from './commercialActivation'

export const ESTIMATE_CALLABLE = 'estimateOperation'
// Longer than the function may run (120 s), so the server's answer arrives first.
export const ESTIMATE_CALL_TIMEOUT_MS = 130000

export const ESTIMATE_ERROR = {
  STALE: 'stale', INVALID: 'invalid', PERMISSION: 'permission', OFFLINE: 'offline',
  MISSING: 'missing', UNAVAILABLE: 'unavailable', UNCERTAIN: 'uncertain',
}

export const ESTIMATE_ERROR_MESSAGES = {
  [ESTIMATE_ERROR.STALE]:       'The estimate changed since you loaded it. Review the latest revision and try again.',
  [ESTIMATE_ERROR.INVALID]:     'This change is not valid for the estimate as it stands. Nothing was changed.',
  [ESTIMATE_ERROR.PERMISSION]:  'You do not have permission to make this change. Nothing was changed.',
  [ESTIMATE_ERROR.OFFLINE]:     'The estimate was being changed at the same time, or the server was busy. Nothing was changed — try again in a moment.',
  [ESTIMATE_ERROR.MISSING]:     'This estimate or project could not be found for your company.',
  [ESTIMATE_ERROR.UNAVAILABLE]: 'Estimating is not available yet. Nothing was changed.',
  [ESTIMATE_ERROR.UNCERTAIN]:   'The server did not confirm the outcome. Check the revision list before trying again — a repeat of the same request is safe.',
}

export class EstimateError extends Error {
  constructor(kind, message, cause) {
    super(message ?? ESTIMATE_ERROR_MESSAGES[kind] ?? ESTIMATE_ERROR_MESSAGES[ESTIMATE_ERROR.UNCERTAIN])
    this.name = 'EstimateError'
    this.kind = kind
    this.code = cause?.details?.code ?? null
    this.details = cause?.details ?? null
    if (cause) this.cause = cause
  }
}

// details.code → [kind, show the server's own sentence?, fixed message?]
const TYPED = {
  'estimate-disabled':             [ESTIMATE_ERROR.UNAVAILABLE, false],
  // Phase 2 company activation (lib/commercialActivation.js): CERTAIN — the
  // company is not yet switched over; nothing was changed.
  [COMMERCIAL_NOT_ACTIVATED_CODE]: [ESTIMATE_ERROR.UNAVAILABLE, false, COMMERCIAL_MAINTENANCE_TEXT],
  'estimate-forbidden':            [ESTIMATE_ERROR.PERMISSION,  true],
  'no-membership':                 [ESTIMATE_ERROR.PERMISSION,  false],
  'membership-inactive':           [ESTIMATE_ERROR.PERMISSION,  false],
  'unauthenticated':               [ESTIMATE_ERROR.PERMISSION,  true],
  'not-found':                     [ESTIMATE_ERROR.MISSING,     false],
  'invalid-argument':              [ESTIMATE_ERROR.INVALID,     false],
  'estimate-invalid':              [ESTIMATE_ERROR.INVALID,     true],
  'estimate-source-invalid':       [ESTIMATE_ERROR.INVALID,     true],
  'estimate-stale':                [ESTIMATE_ERROR.STALE,       false],
  'estimate-id-conflict':          [ESTIMATE_ERROR.INVALID,     true],
  'estimate-building':             [ESTIMATE_ERROR.INVALID,     true],
  'estimate-build-superseded':     [ESTIMATE_ERROR.STALE,       true],
  'estimate-inconsistent':         [ESTIMATE_ERROR.INVALID,     true],
  'estimate-busy':                 [ESTIMATE_ERROR.OFFLINE,     false],
  'approval-segregation-required': [ESTIMATE_ERROR.PERMISSION,  true],
}

// Untyped failures whose outcome is nonetheless certain — answered before the
// handler could run.
const CERTAIN_TRANSPORT = {
  'unauthenticated':   [ESTIMATE_ERROR.PERMISSION,  'Your session has ended or this browser could not be verified. Nothing was changed — reload the page, sign in and try again.'],
  'permission-denied': [ESTIMATE_ERROR.PERMISSION,  undefined],
  'not-found':         [ESTIMATE_ERROR.UNAVAILABLE, 'Estimating is not available on the server yet. Nothing was changed.'],
  'invalid-argument':  [ESTIMATE_ERROR.INVALID,     undefined],
}

export function describeEstimateFailure(err) {
  if (err instanceof EstimateError) return err
  const typed = TYPED[err?.details?.code]
  if (typed) {
    // The server's sentence for a refusal that names items or a reason.
    const own = typeof err?.details?.message === 'string' && err.details.message.length > 0 ? err.details.message
      : (typeof err?.message === 'string' && err.message.length > 0 ? err.message : undefined)
    return new EstimateError(typed[0], typed[1] ? own : typed[2], err)
  }
  const code = String(err?.code ?? '').replace(/^functions\//, '')
  const certain = CERTAIN_TRANSPORT[code]
  if (certain) return new EstimateError(certain[0], certain[1], err)
  return new EstimateError(ESTIMATE_ERROR.UNCERTAIN, undefined, err)
}

// Calls one operation. `call(data)` is the injected transport. Resolves to the
// operation's own answer, which always carries a boolean `alreadyApplied`.
export async function runEstimateOperation(call, operation, request) {
  let result
  try {
    result = await call({ operation, request })
  } catch (err) {
    throw describeEstimateFailure(err)
  }
  if (!result || typeof result !== 'object' || typeof result.alreadyApplied !== 'boolean') {
    throw new EstimateError(ESTIMATE_ERROR.UNCERTAIN)
  }
  return result
}
