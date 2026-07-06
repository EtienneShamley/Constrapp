export const PO_STATUS = {
  DRAFT:            'draft',
  PENDING_APPROVAL: 'pending_approval', // reserved for the approvals workflow — no UI path yet
  SENT:             'sent',
  CLOSED:           'closed',
  CANCELLED:        'cancelled',
}

export const PO_STATUS_LABELS = {
  [PO_STATUS.DRAFT]:            'Draft',
  [PO_STATUS.PENDING_APPROVAL]: 'Pending Approval',
  [PO_STATUS.SENT]:             'Sent',
  [PO_STATUS.CLOSED]:           'Closed',
  [PO_STATUS.CANCELLED]:        'Cancelled',
}

// Maps each status onto an existing Badge variant — no new colours.
export const PO_BADGE_VARIANTS = {
  [PO_STATUS.DRAFT]:            'soon',
  [PO_STATUS.PENDING_APPROVAL]: 'pending',
  [PO_STATUS.SENT]:             'info',
  [PO_STATUS.CLOSED]:           'completed',
  [PO_STATUS.CANCELLED]:        'danger',
}

// Statuses whose value counts toward a budget line's committed cost.
// Once invoicing exists this matures to: committed = PO value − invoiced-to-date.
export const PO_COMMITTED_STATUSES = [PO_STATUS.SENT, PO_STATUS.CLOSED]

// Forward-only lifecycle. pending_approval is reserved; nothing transitions
// into it until the approvals feature ships.
export const PO_TRANSITIONS = {
  [PO_STATUS.DRAFT]:            [PO_STATUS.PENDING_APPROVAL, PO_STATUS.SENT, PO_STATUS.CANCELLED],
  [PO_STATUS.PENDING_APPROVAL]: [PO_STATUS.SENT, PO_STATUS.CANCELLED],
  [PO_STATUS.SENT]:             [PO_STATUS.CLOSED, PO_STATUS.CANCELLED],
  [PO_STATUS.CLOSED]:           [],
  [PO_STATUS.CANCELLED]:        [],
}

export const canTransition = (from, to) => (PO_TRANSITIONS[from] ?? []).includes(to)

export const GST_RATE = 0.1

// Single rounding helper — every money figure passes through here so PO totals
// reconcile to the cent against accounting exports later.
export const roundMoney = (n) => Math.round((n + Number.EPSILON) * 100) / 100

export const lineTotal = (qty, unitPrice) =>
  roundMoney((Number(qty) || 0) * (Number(unitPrice) || 0))

export function poTotals(lineItems) {
  const subtotal = roundMoney(lineItems.reduce((sum, li) => sum + (li.lineTotal || 0), 0))
  const gst      = roundMoney(subtotal * GST_RATE)
  return { subtotal, gst, total: roundMoney(subtotal + gst) }
}

export const formatPoNumber = (n) => `PO-${String(n).padStart(4, '0')}`

// { costCodeId: committedAmount } across all committed POs. Amounts are
// ex-GST line totals — budgets track ex-GST figures.
export function committedByCostCode(purchaseOrders) {
  const map = {}
  for (const po of purchaseOrders) {
    if (!PO_COMMITTED_STATUSES.includes(po.status)) continue
    for (const li of po.lineItems ?? []) {
      if (!li.costCodeId) continue
      map[li.costCodeId] = roundMoney((map[li.costCodeId] || 0) + (li.lineTotal || 0))
    }
  }
  return map
}
