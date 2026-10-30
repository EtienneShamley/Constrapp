import { roundMoney, revisedLineTotal, PO_COMMITTED_STATUSES } from './purchaseOrders'
import {
  classifyCommitmentLines, appliedSupplierVariationAdjustments, isPoLinkedSupplierVariation,
  shouldApplyOnApproval, COMMITMENT_LINE_KIND, isCommitmentApplied, isScopeCommitted,
} from './variations'
import { remainingCommitment } from './commitment'

// ── Commercial-effect preview for Approve / Apply / Commit new scope ─────────
// (M3-B1 ADR-62 · M3-B2 ADR-63)
//
// What the Assess modal and the legacy Apply / Commit dialog show BEFORE the
// user confirms: for every PO line the variation extends, the line's original
// value, what other applied variations already adjusted, what has been
// recognised (posted invoices + approved claims not yet invoiced — the exact
// ADR-55 nets), the remaining commitment now, and the revised value and
// remaining commitment AFTER this variation is applied. New-scope lines are
// listed apart with their own treatment (ADR-63): POSITIVE lines become
// committed, claimable scope when the scope commit is recorded; NEGATIVE lines
// never mature and stay signed exposure for accounting review. Invalid lines
// stay in unapplied exposure. Per affected cost code the saved Uncommitted
// Cost to Complete is shown beside the delta, because the pre-M3-B1 guidance
// told the QS to fold expected variation cost INTO that input — so a non-zero
// CTC MAY already contain this variation. The warning states a possibility; it
// never proves an overlap, and nothing here edits CTC. A PO line whose
// recognition already exceeds its revised value is flagged too: new-scope work
// may have been over-claimed against the base line before M3-B2, and
// committing the new scope would then carry that work twice (ADR-63 — a
// warned human decision, never an automatic reassignment).
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
    applicable: false, po: null, poState: PO_LINK_STATE.NONE, willApply: false, willCommitScope: false,
    alreadyApplied: false, alreadyScopeCommitted: false,
    lines: [], poLines: [], newScope: [], newScopePositive: [], newScopeNegative: [], invalid: [], costCodes: [],
    ctcWarning: false, overRecognitionWarning: false,
    totals: { matured: 0, newScope: 0, newScopeCommittable: 0, newScopeNegative: 0, invalid: 0, remainingBefore: 0, remainingAfter: 0 },
  }
  if (!isPoLinkedSupplierVariation(variation)) return empty

  const po = (purchaseOrders ?? []).find(p => p?.id === variation.poId) ?? null
  const poState = !po ? PO_LINK_STATE.MISSING
    : (PO_COMMITTED_STATUSES.includes(po.status) ? PO_LINK_STATE.COMMITTED : PO_LINK_STATE.NOT_COMMITTED)
  const willApply = shouldApplyOnApproval(variation, po)
  const alreadyApplied = isCommitmentApplied(variation)
  const alreadyScopeCommitted = isScopeCommitted(variation)
  const lines = classifyCommitmentLines(variation, po)

  // Adjustments ALREADY applied to this PO by OTHER variations, and what the
  // PO's lines have recognised so far — the same maps Remaining Committed nets.
  const others = (variations ?? []).filter(v => v && v.id !== variation.id)
  const otherAdj = appliedSupplierVariationAdjustments(others, po ? [po] : [])
  const currentAdj = po ? (otherAdj.byPoLine[po.id] ?? {}) : {}
  const rc = remainingCommitment({ purchaseOrders: po ? [po] : [], progressClaims, supplierInvoices, variations: others })
  const invoiced = po ? (rc.invByPoLine[po.id] ?? {}) : {}
  const recognised = po ? (rc.recByPoLine[po.id] ?? {}) : {}

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
      // Recognition already above the line's CURRENT revised value — the
      // pre-M3-B2 over-claim pattern (new-scope work claimed on the base line).
      overRecognised: recognisedOnLine > currentRevised,
    }
  })

  const newScope = lines.filter(l => l.kind === COMMITMENT_LINE_KIND.NEW_SCOPE)
  const newScopePositive = newScope.filter(l => l.amount > 0)
  const newScopeNegative = newScope.filter(l => l.amount < 0)
  const invalid  = lines.filter(l => l.kind === COMMITMENT_LINE_KIND.INVALID)
  const sum = (rows, key) => roundMoney(rows.reduce((s, r) => s + safeAmount(r[key]), 0))
  // The scope commit is written by the same action as the application (approve,
  // or the legacy Apply / Commit); it matters only when a positive line exists.
  const willCommitScope = willApply && !alreadyScopeCommitted && newScopePositive.length > 0

  // Recognition already above the revised value on ANY line of this PO (not
  // only the lines this variation extends): new-scope work may already have
  // been claimed against a base line, so committing the new scope could carry
  // it twice. Listed as a warning for the QS; nothing is reassigned.
  const overRecognisedPoLines = []
  if (po && willCommitScope) {
    ;(po.lineItems ?? []).forEach((li, idx) => {
      const rev = revisedLineTotal(li, safeAmount(currentAdj[idx]))
      const rec = roundMoney(safeAmount(invoiced[idx]) + safeAmount(recognised[idx]))
      if (rec > rev) overRecognisedPoLines.push({ poLineIndex: idx, costCodeName: li.costCodeName || '', revised: rev, recognised: rec, excess: roundMoney(rec - rev) })
    })
  }

  // Per affected cost code: the delta this variation applies (existing lines
  // + committable new scope) and the saved Uncommitted CTC on that code
  // (null = not forecast).
  const ctcByCode = {}
  for (const f of forecastLines ?? []) {
    const key = f?.costCodeId || f?.id
    if (key) ctcByCode[key] = f.uncommittedCostToComplete ?? null
  }
  const codes = {}
  const addCode = (costCodeId, costCodeName, delta) => {
    if (!costCodeId) return
    const c = codes[costCodeId] ?? (codes[costCodeId] = { costCodeId, costCodeName, delta: 0 })
    c.delta = roundMoney(c.delta + delta)
  }
  for (const r of poLines) addCode(r.costCodeId, r.costCodeName, r.delta)
  if (willCommitScope) for (const l of newScopePositive) addCode(l.costCodeId, l.costCodeName, l.amount)
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
    applicable: true, po, poState, willApply, willCommitScope, alreadyApplied, alreadyScopeCommitted,
    lines, poLines, newScope, newScopePositive, newScopeNegative, invalid, costCodes, overRecognisedPoLines,
    ctcWarning: costCodes.some(c => c.ctcWarning),
    overRecognitionWarning: overRecognisedPoLines.length > 0,
    totals: {
      matured: willApply ? roundMoney(sum(poLines, 'delta') + (willCommitScope ? sum(newScopePositive, 'amount') : 0)) : 0,
      newScope: sum(newScope, 'amount'),
      newScopeCommittable: sum(newScopePositive, 'amount'),
      newScopeNegative: sum(newScopeNegative, 'amount'),
      invalid: sum(invalid, 'amount'),
      remainingBefore: sum(poLines, 'currentRemaining'),
      remainingAfter: willApply ? sum(poLines, 'remainingAfter') : sum(poLines, 'currentRemaining'),
    },
  }
}
