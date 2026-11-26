import { RECONCILIATION_STATE, RECONCILIATION_LABELS } from '../../../lib/payments'

// ── Reconciliation wording on the CLIENT (receivable) side ───────────────────
//
// lib/payments.js labels a negative invoice balance "Over-reconciled". That
// module is shared with the supplier side, where the word is right: too much
// has been paid against a supplier invoice. On the client side the same state
// is a legitimate position — a credit note, or a voided retention release,
// after the money arrived, or an over-allocated receipt — and it means an
// amount is OWED TO THE CLIENT. Every client page takes its reconciliation
// label from here, so that state is never presented as an error of
// reconciliation, as zero, or as a settled invoice.
//
// Presentation only: the state itself is still derived by lib/payments.js.

export const OWED_TO_CLIENT_LABEL = 'Owed to client'

export const CLIENT_RECONCILIATION_LABELS = {
  ...RECONCILIATION_LABELS,
  [RECONCILIATION_STATE.OVER]: OWED_TO_CLIENT_LABEL,
}

export const clientReconciliationLabel = (state) => CLIENT_RECONCILIATION_LABELS[state] ?? state ?? ''

export const isOwedToClient = (state) => state === RECONCILIATION_STATE.OVER

// The remedy, in the words the client pages already use.
export const OWED_TO_CLIENT_REMEDY =
  'Constrap records no refund — the remedy is to void the receipt and re-record it with the surplus unallocated.'

// Tooltip / accessible description for the badge. `amountText` is the POSITIVE
// amount owed, already formatted in the project currency by the caller.
export const owedToClientDescription = (amountText) =>
  `${OWED_TO_CLIENT_LABEL} ${amountText}: more has been received against this invoice than it is now owed. ` +
  `It is not settled. ${OWED_TO_CLIENT_REMEDY}`
