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

// Statuses whose value counts toward a budget line's committed cost. The
// Remaining Committed figure matures each line by posted invoicing AND by
// approved claims not yet invoiced — see remainingCommittedByCostCode.
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

// Statuses a PO may be cancelled FROM — the `cancelled` column of PO_TRANSITIONS.
export const PO_CANCELLABLE_STATUSES = Object.keys(PO_TRANSITIONS)
  .filter(from => PO_TRANSITIONS[from].includes(PO_STATUS.CANCELLED))

// The (timestamp, actor) pair each transition stamps (ADR-57). `sentBy`,
// `closedBy` and `cancelledBy` are M2-B1 additions: Firestore rules require
// the actor to be the caller and the time to be the server's, so a status
// change is attributable and cannot carry a forged stamp. Documents written
// before M2-B1 carry the `*At` keys only; rules read the `*By` keys through
// get(key, null) so those documents stay fully writable.
export const PO_TRANSITION_STAMPS = {
  [PO_STATUS.SENT]:      { at: 'sentAt',      by: 'sentBy' },
  [PO_STATUS.CLOSED]:    { at: 'closedAt',    by: 'closedBy' },
  [PO_STATUS.CANCELLED]: { at: 'cancelledAt', by: 'cancelledBy' },
}

// Ceiling on embedded lines — mirrored by Firestore rules (lineItems.size()).
// Generous: it bounds a document, it is not a business limit.
export const PO_MAX_LINES = 200

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

// ── Source provenance (M3-A, ADR-61) ─────────────────────────────────────────
//
// A PO raised from an awarded tender carries three OPTIONAL, IMMUTABLE keys
// naming its source. They are absent on a manual or legacy PO — never null,
// never partial — and rules verify them against the awarded package and its
// winning bid at create (and the package's back-link, through getAfter()).
// No financial selector reads them: a raised PO is counted exactly like a
// manual one, through its own status and lines.
export const PO_SOURCE_KEYS = ['sourceTenderPackageId', 'sourceTenderBidId', 'sourceTenderNumber']

export const isAwardRaisedPo = (po) =>
  typeof po?.sourceTenderPackageId === 'string' && po.sourceTenderPackageId.length > 0

// THE ONE PO DOCUMENT SHAPE. Both create paths — the manual editor
// (hooks/usePurchaseOrders.jsx → createPurchaseOrder) and the award raise
// (→ createPurchaseOrderFromAward) — build their document here, so the key
// set, the header derivation, the trims, the stamps and the lifecycle nulls
// cannot drift. `now` is the injected serverTimestamp() sentinel; `source` is
// null for a manual PO or { tenderPackageId, tenderBidId, tenderNumber }.
export function buildPurchaseOrderDocument({
  poNumber, supplierName, supplierId, description, notes, lineItems, currency, uid, now, source = null,
}) {
  const { subtotal, gst, total } = poTotals(lineItems)
  const docData = {
    poNumber,
    status:      PO_STATUS.DRAFT,
    supplierName: String(supplierName ?? '').trim(),
    supplierId:  supplierId || null,
    description: String(description ?? '').trim(),
    lineItems,
    subtotal,
    gst,
    total,
    // Audit snapshot of the currency this PO was raised in (the frozen
    // supplierName/costCodeName idiom). The PROJECT currency remains the
    // display authority — this field is never read for rendering.
    currency,
    revision:    1,
    notes:       String(notes ?? '').trim(),
    // Lifecycle stamps — born null. Each transition writes its own (at, by)
    // pair; rules require the actor to be the caller and the time to be the
    // server's (ADR-57).
    sentAt:      null,
    sentBy:      null,
    closedAt:    null,
    closedBy:    null,
    cancelledAt: null,
    cancelledBy: null,
    externalRefs: {},
    createdAt:   now,
    createdBy:   uid,
    // Audit stamps — required by rules on EVERY write since ADR-57.
    updatedAt:   now,
    updatedBy:   uid,
  }
  if (source) {
    docData.sourceTenderPackageId = source.tenderPackageId
    docData.sourceTenderBidId     = source.tenderBidId
    docData.sourceTenderNumber    = source.tenderNumber
  }
  return docData
}

// TOTAL CONTRACTUAL COMMITMENT — { costCodeId: Σ lineTotal } across every
// sent/closed PO, ex-GST. This is the full ordered value and is deliberately
// kept apart from Remaining Committed below: it never matures, never nets a
// claim or an invoice, and answers "what have we ordered?" rather than "what
// is still to be recognised?".
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

// Remaining Committed — THE ONE open-commitment formula (ADR-55).
//
// Per PO line (POs in sent/closed):
//
//   open(line) = max(0, lineTotal
//                       − posted/paid invoiced against the line
//                       − approved claim value on the line NOT yet superseded
//                         by a posted claim-sourced invoice)
//
// grouped by cost code. "Committed" therefore means "ordered and not yet
// RECOGNISED as Actual": a cost leaves Committed at the same moment it enters
// Actual, whether that moment is an approved claim or a posted invoice, so the
// two figures are complementary and Forecast Final Cost (Actual + Remaining
// Committed + Uncommitted CTC) counts each dollar exactly once.
//
// Before ADR-55 only posted invoicing matured a line. An approved claim was
// counted in Actual while the full PO line stayed in Committed until the
// claim-sourced invoice POSTED, so for that window FFC carried the claim twice
// (the pinned fixture read 1,250 where 950 was true).
//
// NO DOUBLE SUBTRACTION. `recognisedClaimsByPoLine` excludes every claim whose
// posted invoice is in `invoicedByPoLine` (same `invoicedClaimIds` set the
// claim side of Actual uses), so when a claim's invoice posts the claim amount
// leaves one map and the invoice amount enters the other and the line's open
// commitment is unchanged. A posted DIRECT invoice on a line that also carries
// an approved claim does subtract twice — that is the mixed-mode conflict
// SHIELD and the editors surface (lib/poLineRecognition.js); the figure is
// never silently repaired.
//
// A claim line with no `poLineIndex` (legacy shape) cannot be attributed to a
// PO line and does NOT reduce commitment — the pre-ADR-55 reading, which errs
// toward overstating open commitment rather than hiding it.
//
// `invoicedByPoLine`  — supplierInvoices.postedInvoicedByPoLine
//                       → { [poId]: { [poLineIndex]: ex-GST amount } }
// `recognisedByPoLine` — progressClaims.recognisedClaimsByPoLine
//                       → { [poId]: { [poLineIndex]: ex-GST approved amount } }
export function remainingCommittedByPoLine(purchaseOrders, invoicedByPoLine = {}, recognisedByPoLine = {}) {
  const map = {}
  for (const po of purchaseOrders) {
    if (!PO_COMMITTED_STATUSES.includes(po.status)) continue
    const invForPo = invoicedByPoLine[po.id] ?? {}
    const recForPo = recognisedByPoLine[po.id] ?? {}
    const forPo = {}
    ;(po.lineItems ?? []).forEach((li, idx) => {
      const remaining = Math.max(
        roundMoney((li.lineTotal || 0) - (invForPo[idx] || 0) - (recForPo[idx] || 0)),
        0,
      )
      forPo[idx] = remaining
    })
    map[po.id] = forPo
  }
  return map
}

// { costCodeId: Remaining Committed } — the per-line formula above grouped by
// the line's cost code. Lines with no cost code are skipped (they cannot reach
// a budget row); exhausted lines contribute nothing and a code with no open
// commitment is absent from the map (never a negative).
export function remainingCommittedByCostCode(purchaseOrders, invoicedByPoLine = {}, recognisedByPoLine = {}) {
  const map = {}
  const byLine = remainingCommittedByPoLine(purchaseOrders, invoicedByPoLine, recognisedByPoLine)
  for (const po of purchaseOrders) {
    const forPo = byLine[po.id]
    if (!forPo) continue
    ;(po.lineItems ?? []).forEach((li, idx) => {
      if (!li.costCodeId) return
      const remaining = forPo[idx] || 0
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
// frozen at the product level. Since ADR-57 (M2-B1) the draft-only edit, the
// freeze after `sent` and the legal transitions are RULES-ENFORCED once the
// revised firestore.rules is published (docs/SECURITY.md → Purchase Orders).
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

// Blank / absent counts as 0; anything else must be a finite number >= 0.
const nonNegativeAmount = (v) => {
  if (v == null || v === '') return true
  const n = Number(v)
  return Number.isFinite(n) && n >= 0
}

// Draft content validation shared by create and edit — the existing product
// rules: at least one line (and at most PO_MAX_LINES), a cost code on every
// line, and no negative quantity or rate (ADR-57).
// Description, qty, unit and rate are deliberately NOT required. When the
// live `costCodes` list is supplied, every line's id must ALSO resolve to it —
// a stored line whose cost code has since been removed blocks the save until
// a current code is chosen (ADR-36); it is never silently preserved.
// Returns null when valid, otherwise the first error message.
export function validatePoDraft({ lineItems, costCodes = null } = {}) {
  const lines = Array.isArray(lineItems) ? lineItems : []
  if (lines.length === 0) return 'At least one line item is required'
  if (lines.length > PO_MAX_LINES) return `A purchase order can carry at most ${PO_MAX_LINES} lines`
  const missing = lines.findIndex(li => !(typeof li?.costCodeId === 'string' && li.costCodeId.length > 0))
  if (missing !== -1) return `Line ${missing + 1}: a cost code is required`
  // Quantity and rate may be blank (0) but never negative — a negative line
  // would make the stored subtotal negative, which Firestore rules refuse
  // (ADR-57). The editor's `min="0"` is browser constraint validation, not a
  // control; this is the domain check the hook relies on.
  const negative = lines.findIndex(li => !nonNegativeAmount(li?.qty) || !nonNegativeAmount(li?.unitPrice))
  if (negative !== -1) return `Line ${negative + 1}: quantity and rate cannot be negative`
  if (Array.isArray(costCodes)) {
    const unresolved = lines.findIndex(li => !costCodes.some(c => c.id === li.costCodeId))
    if (unresolved !== -1) return `Line ${unresolved + 1}: choose a current cost code`
  }
  return null
}
