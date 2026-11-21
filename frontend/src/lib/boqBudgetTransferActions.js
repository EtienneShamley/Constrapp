import { isReviewKeyShape, normaliseZeroChoices, TRANSFER_OUTCOME } from './boqBudgetTransfer'

// ── BOQ → working budget transfer: the CALL (ADR-81) ─────────────────────────
//
// The browser never writes a BOQ-sourced budget line: Firestore rules reserve
// the `boq-…` ids and the `boqSource` field against every client create. The
// transfer is the trusted callable `transferBoqToBudget`, which recomputes the
// proposal from records it reads itself inside one transaction. This module
// builds the request, makes the call through an INJECTED `call` (so it imports
// no Firebase code) and turns the answer into one of SIX honest outcomes:
//
//   APPLIED          the server created or changed working lines
//   ALREADY_APPLIED  this exact request was applied earlier and nothing has
//                    changed since — nothing was written this time
//   UNCHANGED        the review is current and there was nothing to write
//   STALE_REVIEW     the BOQ or the working budget changed since the review —
//                    the server refused, nothing was written
//   BLOCKED          a chosen set-to-zero is no longer eligible — refused
//   FAILED           a typed refusal, or a transport failure whose outcome IS
//                    certain (not signed in, App Check, no such function)
//   UNCERTAIN        no typed answer — the transfer MAY have committed
//
// The first three are results; the rest are thrown as BoqTransferError. Its
// `code` is a Firestore-style status so lib/writeOutcome.js → describeWriteError
// (the L3 convention) classifies it without learning anything new: a definite
// code for a certain refusal, an ambiguous one for an uncertain outcome.
//
// ⚠️ NOTHING HERE RETRIES. A repeat is the user's decision; it is SAFE because
// the server recognises a request it already applied.

export const BOQ_TRANSFER_ERROR = {
  STALE_REVIEW: 'stale-review',
  BLOCKED:      'blocked',
  FAILED:       'failed',
  UNCERTAIN:    'uncertain',
}

export const BOQ_TRANSFER_MESSAGES = {
  stale:      'The BOQ or the working budget changed since you reviewed this transfer. Nothing was written. The list below now shows the current position — review it and confirm again.',
  blocked:    'A cost code chosen for set-to-zero is no longer eligible. Nothing was written. Review the list and confirm again.',
  busy:       'The BOQ or the budget was being changed while this transfer ran. Nothing was written — try again.',
  forbidden:  'Only a Company Admin, Project Manager or QS can transfer the BOQ to the budget. Nothing was written.',
  disabled:   'BOQ to budget transfer is temporarily unavailable. Nothing was written.',
  tooLarge:   'This project holds more records than a transfer can read in one step. Nothing was written.',
  notFound:   'This project could not be found for your company. Nothing was written.',
  notReady:   'BOQ to budget transfer is not available on the server yet. Nothing was written.',
  signedOut:  'Your session has ended or this browser could not be verified. Nothing was written — reload the page, sign in and try again.',
  invalid:    'The transfer request was not valid. Nothing was written — reload the page and review it again.',
}

// details.code (functions/src/lib/errors.js) → [kind, Firestore-style code, message]
const TYPED = {
  'boq-transfer-stale-review': [BOQ_TRANSFER_ERROR.STALE_REVIEW, 'failed-precondition', BOQ_TRANSFER_MESSAGES.stale],
  'boq-transfer-blocked':      [BOQ_TRANSFER_ERROR.BLOCKED,      'failed-precondition', BOQ_TRANSFER_MESSAGES.blocked],
  'boq-transfer-busy':         [BOQ_TRANSFER_ERROR.FAILED,       'aborted',             BOQ_TRANSFER_MESSAGES.busy],
  'boq-transfer-forbidden':    [BOQ_TRANSFER_ERROR.FAILED,       'permission-denied',   BOQ_TRANSFER_MESSAGES.forbidden],
  'boq-transfer-disabled':     [BOQ_TRANSFER_ERROR.FAILED,       'failed-precondition', BOQ_TRANSFER_MESSAGES.disabled],
  'boq-transfer-too-large':    [BOQ_TRANSFER_ERROR.FAILED,       'failed-precondition', BOQ_TRANSFER_MESSAGES.tooLarge],
  'not-found':                 [BOQ_TRANSFER_ERROR.FAILED,       'not-found',           BOQ_TRANSFER_MESSAGES.notFound],
  'no-membership':             [BOQ_TRANSFER_ERROR.FAILED,       'permission-denied',   BOQ_TRANSFER_MESSAGES.forbidden],
  'membership-inactive':       [BOQ_TRANSFER_ERROR.FAILED,       'permission-denied',   BOQ_TRANSFER_MESSAGES.forbidden],
  'unauthenticated':           [BOQ_TRANSFER_ERROR.FAILED,       'unauthenticated',     BOQ_TRANSFER_MESSAGES.signedOut],
  'invalid-argument':          [BOQ_TRANSFER_ERROR.FAILED,       'invalid-argument',    BOQ_TRANSFER_MESSAGES.invalid],
}

// Untyped callable failures whose outcome is nonetheless CERTAIN: each is
// answered before the handler can run.
const CERTAIN_TRANSPORT = {
  'unauthenticated':   ['unauthenticated',   BOQ_TRANSFER_MESSAGES.signedOut],   // no ID token, or App Check refused the request
  'permission-denied': ['permission-denied', BOQ_TRANSFER_MESSAGES.forbidden],
  'not-found':         ['not-found',         BOQ_TRANSFER_MESSAGES.notReady],    // the function is not deployed
  'invalid-argument':  ['invalid-argument',  BOQ_TRANSFER_MESSAGES.invalid],
}

export class BoqTransferError extends Error {
  constructor(kind, code, message, cause) {
    super(message)
    this.name = 'BoqTransferError'
    this.kind = kind
    this.code = code
    if (cause) this.cause = cause
  }
}

export function describeTransferFailure(err) {
  const typed = TYPED[err?.details?.code]
  if (typed) return new BoqTransferError(typed[0], typed[1], typed[2], err)
  const code = String(err?.code ?? '').replace(/^functions\//, '')
  const certain = CERTAIN_TRANSPORT[code]
  if (certain) return new BoqTransferError(BOQ_TRANSFER_ERROR.FAILED, certain[0], certain[1], err)
  // No typed answer: a timeout, a dropped connection or an internal error.
  // The request may have reached the server and the transfer may have
  // committed — never "nothing was written" here. The message is left to
  // describeWriteError (the shared uncertain wording).
  return new BoqTransferError(BOQ_TRANSFER_ERROR.UNCERTAIN, code === 'unavailable' ? 'unavailable' : 'deadline-exceeded', '', err)
}

// The browser waits LONGER than the function may run (120 s, functions/src/
// index.js → BOQ_TRANSFER_CALL_OPTIONS), so the server's own answer arrives
// before the client gives up (the approveFinalAccount reasoning).
export const TRANSFER_CALL_TIMEOUT_MS = 130000

const OUTCOMES = Object.values(TRANSFER_OUTCOME)

// `call(data)` invokes transferBoqToBudget and resolves to its result. The
// request names the project, the reviewed proposal and the set-to-zero
// choices — NEVER an amount.
export async function runBoqBudgetTransfer({ call, projectId, reviewKey, setToZero = [] }) {
  if (!projectId || !isReviewKeyShape(reviewKey)) {
    throw new BoqTransferError(BOQ_TRANSFER_ERROR.FAILED, 'invalid-argument', BOQ_TRANSFER_MESSAGES.invalid)
  }
  let result
  try {
    result = await call({ projectId, reviewKey, setToZero: normaliseZeroChoices(setToZero) })
  } catch (err) {
    throw describeTransferFailure(err)
  }
  // An answer that is not one of the three outcomes says nothing reliable.
  if (!result || !OUTCOMES.includes(result.outcome)) {
    throw new BoqTransferError(BOQ_TRANSFER_ERROR.UNCERTAIN, 'deadline-exceeded', '')
  }
  return result
}

// What the dialog says about a server-confirmed outcome.
export function transferOutcomeText(result, money = (n) => String(n)) {
  const n = (count, one, many) => `${count} ${count === 1 ? one : many}`
  if (result?.outcome === TRANSFER_OUTCOME.APPLIED) {
    const parts = []
    if (result.created > 0) parts.push(`${n(result.created, 'budget line', 'budget lines')} created`)
    if (result.refreshed > 0) parts.push(`${n(result.refreshed, 'line', 'lines')} refreshed`)
    if (result.zeroed > 0) parts.push(`${n(result.zeroed, 'line', 'lines')} set to zero`)
    return {
      title: 'Transfer applied',
      body: `The server confirmed: ${parts.join(', ')}. Those working lines moved from ${money(result.before)} to ${money(result.after)}.`,
    }
  }
  if (result?.outcome === TRANSFER_OUTCOME.ALREADY_APPLIED) {
    return {
      title: 'Already applied',
      body: 'The server confirmed that this transfer was applied earlier and that nothing has changed since. Nothing was written again.',
    }
  }
  return {
    title: 'Nothing to transfer',
    body: 'The server confirmed that the working budget already matches the BOQ for every transferable cost code. Nothing was written.',
  }
}
