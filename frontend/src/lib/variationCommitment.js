import { roundMoney, revisedLineTotal, PO_COMMITTED_STATUSES } from './purchaseOrders'
import { recognisedClaimsByPoLine } from './progressClaims'
import { postedInvoicedByPoLine, invoicedClaimIds } from './supplierInvoices'
import {
  classifyCommitmentLines, appliedSupplierVariationAdjustments, isPoLinkedSupplierVariation,
  shouldApplyOnApproval, COMMITMENT_LINE_KIND,
} from './variations'

// ── Commercial-effect preview for Approve / Apply (M3-B1, ADR-62) ────────────
//
// What the Assess modal and the legacy Apply dialog show BEFORE the user
// confirms: for every PO line the variation extends, the line's original value,
// what other applied variations already adjusted, what has been recognised
// (posted invoices + approved claims not yet invoiced — the exact ADR-55 nets),
// the remaining commitment now, and the revised value and remaining commitment
// AFTER this variation is applied. New-scope and invalid lines are listed
// separately (they will stay in unapplied exposure). Per affected cost code the
// saved Uncommitted Cost to Complete is shown beside the delta, because the
// pre-M3-B1 guidance told the QS to fold expected variation cost INTO that
// input — so a non-zero CTC MAY already contain this variation. The warning
// states a possibility; it never proves an overlap, and nothing here edits CTC.
//
// Pure: reads the registers it is given and writes nothing. `variation` may be
// a PREVIEW (the submitted document with the certified amounts the assessor is
// about to approve), so `approvedAmount` on each line is what is classified.

export const PO_LINK_STATE = {
  NONE:          'none',          // not a PO-linked supplier variation
  COMMITTED:     'committed',     // PO found, sent/closed — application possible
  NOT_COMMITTED: 'not_committed', // PO found, draft / pending / cancelled
  MISSING:       'missing',       // PO not in the register
}

const safeAmount = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0)

export function commitmentEffectPreview({
  variation, purchaseOrders = [], progressClaims = [], supplierInvoices = [], variations = [], forecastLines = [],
} = {}) {
  const empty = {
    applicable: false, po: null, poState: PO_LINK_STATE.NONE, willApply: false,
    lines: [], poLines: [], newScope: [], invalid: [], costCodes: [], ctcWarning: false,
    totals: { matured: 0, newScope: 0, invalid: 0, remainingBefore: 0, remainingAfter: 0 },
  }
  if (!isPoLinkedSupplierVariation(variation)) return empty

  const po = (purchaseOrders ?? []).find(p => p?.id === variation.poId) ?? null
  const poState = !po ? PO_LINK_STATE.MISSING
    : (PO_COMMITTED_STATUSES.includes(po.status) ? PO_LINK_STATE.COMMITTED : PO_LINK_STATE.NOT_COMMITTED)
  const willApply = shouldApplyOnApproval(variation, po)
  const lines = classifyCommitmentLines(variation, po)

  // Adjustments ALREADY applied to this PO by OTHER variations, and what the
  // PO's lines have recognised so far — the same maps Remaining Committed nets.
  const others = (variations ?? []).filter(v => v && v.id !== variation.id)
  const currentAdj = po ? (appliedSupplierVariationAdjustments(others, [po]).byPoLine[po.id] ?? {}) : {}
  const invoiced = po ? (postedInvoicedByPoLine(supplierInvoices ?? [])[po.id] ?? {}) : {}
  const recognised = po ? (recognisedClaimsByPoLine(progressClaims ?? [], invoicedClaimIds(supplierInvoices ?? []))[po.id] ?? {}) : {}

  // Delta per PO line from THIS variation's existing-line amounts.
  const deltaByLine = {}
  for (const l of lines) {
    if (l.kind !== COMMITMENT_LINE_KIND.EXISTING_LINE) continue
    deltaByLine[l.poLineIndex] = roundMoney((deltaByLine[l.poLineIndex] || 0) + l.amount)
  }

  const poLines = Object.keys(deltaByLine).map(Number).sort((a, b) => a - b).map(idx => {
    const li = po.lineItems[idx]
    const currentAdjustment = roundMoney(safeAmount(currentAdj[idx]))
    const recognisedOnLine = roundMoney(safeAmount(invoiced[idx]) + safeAmount(recognised[idx]))
    const currentRevised = revisedLineTotal(li, currentAdjustment)
    const delta = deltaByLine[idx]
    const revisedAfter = roundMoney(currentRevised + delta)
    return {
      poLineIndex: idx,
      costCodeId: li.costCodeId || '', costCodeName: li.costCodeName || '', description: li.description || '',
      original: roundMoney(safeAmount(li.lineTotal)),
      currentAdjustment, currentRevised,
      recognised: recognisedOnLine,
      currentRemaining: Math.max(0, roundMoney(currentRevised - recognisedOnLine)),
      delta,
      revisedAfter,
      remainingAfter: Math.max(0, roundMoney(revisedAfter - recognisedOnLine)),
      negativeAfter: revisedAfter < 0,
    }
  })

  const newScope = lines.filter(l => l.kind === COMMITMENT_LINE_KIND.NEW_SCOPE)
  const invalid  = lines.filter(l => l.kind === COMMITMENT_LINE_KIND.INVALID)
  const sum = (rows, key) => roundMoney(rows.reduce((s, r) => s + safeAmount(r[key]), 0))

  // Per affected cost code: the delta this variation applies and the saved
  // Uncommitted CTC on that code (null = not forecast).
  const ctcByCode = {}
  for (const f of forecastLines ?? []) {
    const key = f?.costCodeId || f?.id
    if (key) ctcByCode[key] = f.uncommittedCostToComplete ?? null
  }
  const codes = {}
  for (const r of poLines) {
    if (!r.costCodeId) continue
    const c = codes[r.costCodeId] ?? (codes[r.costCodeId] = { costCodeId: r.costCodeId, costCodeName: r.costCodeName, delta: 0 })
    c.delta = roundMoney(c.delta + r.delta)
  }
  const costCodes = Object.values(codes).map(c => {
    const ctc = ctcByCode[c.costCodeId] ?? null
    const ctcNumber = ctc === null || ctc === undefined || ctc === '' ? null : Number(ctc)
    return {
      ...c,
      uncommittedCtc: Number.isFinite(ctcNumber) ? ctcNumber : null,
      // A warning, not a finding: a positive saved CTC on a code this
      // variation adjusts MAY already contain the variation's cost.
      ctcWarning: willApply && Number.isFinite(ctcNumber) && ctcNumber > 0 && c.delta !== 0,
    }
  }).sort((a, b) => a.costCodeName.localeCompare(b.costCodeName))

  return {
    applicable: true, po, poState, willApply, lines, poLines, newScope, invalid, costCodes,
    ctcWarning: costCodes.some(c => c.ctcWarning),
    totals: {
      matured: willApply ? sum(poLines, 'delta') : 0,
      newScope: sum(newScope, 'amount'),
      invalid: sum(invalid, 'amount'),
      remainingBefore: sum(poLines, 'currentRemaining'),
      remainingAfter: willApply ? sum(poLines, 'remainingAfter') : sum(poLines, 'currentRemaining'),
    },
  }
}
