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

// Matured Committed: the remaining *open* commitment once supplier invoices
// exist. Per PO line, the open commitment is the line total minus what has been
// invoiced (posted/paid) against that line, floored at zero, then grouped by
// cost code. Committed therefore now means "ordered but not yet invoiced"; as
// invoices post, value moves out of Committed and into Invoiced/Actual, so the
// two are complementary rather than overlapping. `invoicedByPoLine` comes from
// supplierInvoices.postedInvoicedByPoLine → { [poId]: { [poLineIndex]: amount } }.
export function maturedCommittedByCostCode(purchaseOrders, invoicedByPoLine = {}) {
  const map = {}
  for (const po of purchaseOrders) {
    if (!PO_COMMITTED_STATUSES.includes(po.status)) continue
    const invForPo = invoicedByPoLine[po.id] ?? {}
    ;(po.lineItems ?? []).forEach((li, idx) => {
      if (!li.costCodeId) return
      const remaining = Math.max(roundMoney((li.lineTotal || 0) - (invForPo[idx] || 0)), 0)
      if (remaining <= 0) return
      map[li.costCodeId] = roundMoney((map[li.costCodeId] || 0) + remaining)
    })
  }
  return map
}

// ── Draft editor line helpers (ADR-36) ───────────────────────────────────────
// Pure mapping between the editor's form state and the stored line model, shared
// by CREATE and EDIT DRAFT so the two modes cannot drift. Form state holds
// strings (input values); the stored line holds the canonical numbers plus the
// frozen costCodeName snapshot. Nothing here mutates its inputs.

// Statuses whose authored content (description, notes, lines) may still change.
// Exactly draft — pending_approval is reserved and, like every later status,
// frozen at the product level. Enforced in the client hook only (rules do not
// check status — SECURITY.md Deferred Control 2).
export const PO_EDITABLE_STATUSES = [PO_STATUS.DRAFT]

// Blank editor line — every form line has exactly these five keys.
export const EMPTY_PO_FORM_LINE = Object.freeze({
  costCodeId: '', description: '', qty: '', unit: '', unitPrice: '',
})

// Stored line → editor form line. Numbers become strings (0 → '0'); null /
// undefined become ''. Legacy / partial / non-object input maps to a blank line.
export function poLineToForm(line) {
  const li = line && typeof line === 'object' ? line : {}
  const num = (v) => (v == null || v === '' ? '' : String(v))
  return {
    costCodeId:  typeof li.costCodeId === 'string' ? li.costCodeId : '',
    description: typeof li.description === 'string' ? li.description : '',
    qty:         num(li.qty),
    unit:        typeof li.unit === 'string' ? li.unit : '',
    unitPrice:   num(li.unitPrice),
  }
}

// Editor form line → stored line, exactly as the create flow always built it:
// qty/unitPrice via Number(x) || 0, lineTotal via lineTotal(), description and
// unit trimmed, and costCodeName re-snapshotted from the LIVE cost-code list
// ('' when the id is unknown — validatePoDraft then rejects the line, so a
// removed/inactive cost code is never silently preserved).
export function buildPoLineItem(formLine, { costCodes = [] } = {}) {
  const l = formLine && typeof formLine === 'object' ? formLine : {}
  const costCodeId = typeof l.costCodeId === 'string' ? l.costCodeId : ''
  const cc = (costCodes ?? []).find(c => c.id === costCodeId)
  return {
    costCodeId,
    costCodeName: cc ? `${cc.code} — ${cc.name}` : '',
    description:  String(l.description ?? '').trim(),
    qty:          Number(l.qty) || 0,
    unit:         String(l.unit ?? '').trim(),
    unitPrice:    Number(l.unitPrice) || 0,
    lineTotal:    lineTotal(l.qty, l.unitPrice),
  }
}

// Draft content validation shared by create and edit — the existing product
// rules, unchanged: at least one line, and a cost code on every line.
// Description, qty, unit and rate are deliberately NOT required. When the
// live `costCodes` list is supplied, every line's id must ALSO resolve to it —
// a stored line whose cost code has since been removed blocks the save until
// a current code is chosen (ADR-36); it is never silently preserved.
// Returns null when valid, otherwise the first error message.
export function validatePoDraft({ lineItems, costCodes = null } = {}) {
  const lines = Array.isArray(lineItems) ? lineItems : []
  if (lines.length === 0) return 'At least one line item is required'
  const missing = lines.findIndex(li => !(typeof li?.costCodeId === 'string' && li.costCodeId.length > 0))
  if (missing !== -1) return `Line ${missing + 1}: a cost code is required`
  if (Array.isArray(costCodes)) {
    const unresolved = lines.findIndex(li => !costCodes.some(c => c.id === li.costCodeId))
    if (unresolved !== -1) return `Line ${unresolved + 1}: choose a current cost code`
  }
  return null
}
