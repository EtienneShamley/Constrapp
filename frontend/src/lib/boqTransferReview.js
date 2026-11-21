import { BOQ_STATUS, isPriced } from './boq'
import { transferRequestKey, normaliseZeroChoices } from './boqBudgetTransfer'

// ── BOQ → budget transfer: the reviewer's confirmation (ADR-81, L4 correction) ─
//
// Browser-only and pure: no React, no Firebase. It is NOT part of the server
// bundle (functions/src/generated/boqBudgetTransferCalc.js is built from
// lib/boqBudgetTransfer.js alone), so nothing here changes what the callable
// computes, checks or writes.
//
// THE RULE: a tick confirms ONE exact request — the reviewed proposal's
// reviewKey plus the set-to-zero choices made on it (transferRequestKey). The
// dialog stores that key, never a bare boolean, so:
//   · the tick is shown only while the stored key equals the CURRENT key — it
//     disappears in the same render that shows the changed proposal, with no
//     effect to wait for;
//   · a stale key is then cleared for good (reconcileConfirmation), so going
//     back to the earlier figures does not silently restore the tick;
//   · submit re-derives the current key and sends nothing unless it matches.
// The reviewKey leaves out display names, descriptions, notes, timestamps and
// read order, so an unrelated render or an unchanged snapshot keeps the tick.
// The server's own stale-review refusal is unchanged and still applies.

export const transferConfirmationKey = (reviewKey, zeroChoices) =>
  typeof reviewKey === 'string' && reviewKey ? transferRequestKey(reviewKey, zeroChoices) : null

export const isConfirmationCurrent = (confirmedFor, currentKey) =>
  typeof confirmedFor === 'string' && confirmedFor !== '' && confirmedFor === currentKey

// What the stored confirmation should become now: kept only while it still
// names the current request.
export const reconcileConfirmation = (confirmedFor, currentKey) =>
  isConfirmationCurrent(confirmedFor, currentKey) ? confirmedFor : null

export function canSubmitTransfer({ ready, locked, pending, operationCount, confirmedFor, currentKey }) {
  if (!ready || locked) return false
  // An unanswered request is resent exactly as sent — its own reviewed key.
  if (pending) return true
  return operationCount > 0 && isConfirmationCurrent(confirmedFor, currentKey)
}

// The request a submit may send, or null when it must send nothing. Called
// with the values the submit handler sees; independent of any render effect.
export function transferRequestToSend({ pending, reviewKey, zeroChoices, confirmedFor }) {
  if (pending) return pending
  const currentKey = transferConfirmationKey(reviewKey, zeroChoices)
  if (!isConfirmationCurrent(confirmedFor, currentKey)) return null
  return { reviewKey, setToZero: normaliseZeroChoices(zeroChoices) }
}

// ── Copy ─────────────────────────────────────────────────────────────────────

export const reviewedChangesPhrase = (n) => (n === 1 ? 'this change' : `these ${n} changes`)

export function confirmationLabel(operationCount, zeroCount) {
  const zero = zeroCount > 0 ? `, including ${zeroCount === 1 ? '1 line' : `${zeroCount} lines`} set to zero` : ''
  return `I have reviewed ${reviewedChangesPhrase(operationCount)} to the working budget${zero}.`
}

// The names of the ACTIVE, unpriced BOQ items on a cost code, from the BOQ
// register the page already holds (same active/priced rules as the proposal).
export function unpricedItemLabels(boqItems, costCodeId, limit = 3) {
  const labels = []
  for (const item of boqItems ?? []) {
    if (!item || item.status !== BOQ_STATUS.ACTIVE || item.costCodeId !== costCodeId || isPriced(item.rate)) continue
    const no = typeof item.itemNumber === 'string' ? item.itemNumber.trim() : ''
    const desc = typeof item.description === 'string' ? item.description.trim() : ''
    labels.push([no, desc].filter(Boolean).join(' ') || 'Unnamed item')
  }
  labels.sort((a, b) => a.localeCompare(b))
  return { shown: labels.slice(0, limit), more: Math.max(0, labels.length - limit) }
}

// Uncertain outcome (L3 write-outcome UNCERTAIN / UNCONFIRMED). The transfer
// is idempotent, so the wording neither claims it failed nor that it saved.
export const TRANSFER_UNCERTAIN_ACK_LABEL =
  'I have checked the budget lines — let me send the same transfer again.'
export const TRANSFER_UNCERTAIN_HINT =
  'The result is not known: it may or may not have been applied. Check the Budget tab or the list above. ' +
  'Nothing is retried automatically. Sending again resends this same reviewed transfer, not a new one — ' +
  'the server applies it once only, so if it already went through it answers "already applied" and writes nothing.'
