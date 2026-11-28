import {
  CLAIM_STATUS, CLAIM_OPEN_STATUSES, CLAIM_APPROVED_STATUSES, CLAIMABLE_PO_STATUSES, CLAIM_LINK_INITIAL,
  buildClaimLine, buildVariationClaimLine, validateClaimDraft, claimTotalsFor, claimedThisPeriodFor,
  claimVariationLineIssue, CLAIM_VARIATION_LINE_ISSUE_LABELS, claimVariationLineCount, CLAIM_MAX_LINES,
} from './progressClaims'
import { CALC_VERSION, CURRENT_CALC_VERSION, calcVersionOf, roundToCents } from './supplierCalc'
import { isVariationOriginLine, indexOrNull, sourceLineIdentityError, sourceLineLabel } from './sourceLine'
import { classifyCommitmentLines, claimableNewScopeLines } from './variations'
import { toCents, fromCents, isWholeCents } from './money'

// ── Progress claims on the trusted boundary (Phase 2 step 3, ADR-93) ─────────
//
// PURE. The browser and the trusted backend (functions/src/supplierFinance,
// through the generated bundle) share these functions, so a request the
// browser builds is refused for the same reason on both sides, and every
// stored figure of a claim is derived here — never taken from a request.
//
// A claim is CREATED, its DRAFT EDITED, APPROVED and REJECTED only by the
// backend. Submit stays a content-free Rules transition (draft → submitted:
// status, stamps, revision).
//
// THE PER-PURCHASE-ORDER CLAIM LEDGER (`…/poClaimLedgers/{poId}`, server-only):
//   openClaimIds               the claims on the PO in draft / submitted /
//                              under_review (the one-open-claim invariant,
//                              Deferred Control 36 — now authoritative);
//   approvedPoLineCents        { poLineIndex: Σ certified ex-GST } and
//   approvedVariationLineCents { "variationId:lineIndex": Σ certified } —
//                              the authoritative `previouslyApproved` of every
//                              new claim line, read from ONE document instead
//                              of re-scanning the PO's claim history.
// It moves only in the transactions that create, approve or reject a claim.

export const CLAIM_PROCESSING_ROLES = ['company_admin', 'project_manager', 'qs']
export const CLAIM_NOTES_MAX = 5000
export const CLAIM_REF_MAX = 200
export const CLAIM_COUNTER_ID = 'progressClaims'

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const exactKeys = (data, keys) => isObject(data) && Object.keys(data).length === keys.length && keys.every(k => k in data)
const isId = (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(v)
const isRevision = (v) => Number.isInteger(v) && v >= 0 && v <= Number.MAX_SAFE_INTEGER
const DATE_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/
const isDateOrEmpty = (v) => typeof v === 'string' && (v === '' || DATE_RE.test(v))
const isText = (v, max) => typeof v === 'string' && v.length <= max
const isAmount = (v) => typeof v === 'number' && Number.isFinite(v) && roundToCents(v) !== null

// ── Requests ─────────────────────────────────────────────────────────────────

export const CREATE_CLAIM_KEYS = ['projectId', 'claimId', 'poId', 'periodEnding', 'claimRef', 'notes', 'retention', 'lines']
export const CLAIM_LINE_KEYS = ['poLineIndex', 'variationId', 'variationLineIndex', 'claimedToDate']
export const UPDATE_CLAIM_KEYS = ['projectId', 'claimId', 'expectedRevision', 'periodEnding', 'claimRef', 'notes', 'retention', 'claimedToDate']
export const APPROVE_CLAIM_KEYS = ['projectId', 'claimId', 'expectedRevision', 'approvedAmounts', 'assessmentNotes']
export const REJECT_CLAIM_KEYS = ['projectId', 'claimId', 'expectedRevision', 'assessmentNotes']

function headerProblem(data) {
  if (!isId(data.projectId) || !isId(data.claimId)) return 'ids'
  if (!isDateOrEmpty(data.periodEnding)) return 'periodEnding'
  if (!isText(data.claimRef, CLAIM_REF_MAX)) return 'claimRef'
  if (!isText(data.notes, CLAIM_NOTES_MAX)) return 'notes'
  if (!isAmount(data.retention) || data.retention < 0 || !isWholeCents(data.retention)) return 'retention'
  return null
}

export function createClaimRequestProblem(data) {
  if (!exactKeys(data, CREATE_CLAIM_KEYS)) return 'keys'
  const header = headerProblem(data)
  if (header) return header
  if (!isId(data.poId)) return 'poId'
  if (!Array.isArray(data.lines) || data.lines.length === 0 || data.lines.length > CLAIM_MAX_LINES) return 'lines'
  for (const line of data.lines) {
    if (!exactKeys(line, CLAIM_LINE_KEYS)) return 'line-keys'
    if (!isAmount(line.claimedToDate)) return 'line-amount'
    const po = line.poLineIndex
    const v = line.variationId
    if (v === null) {
      if (indexOrNull(po) === null || line.variationLineIndex !== null) return 'line-source'
    } else if (!isId(v) || po !== null || indexOrNull(line.variationLineIndex) === null) return 'line-source'
  }
  return null
}

export function updateClaimRequestProblem(data) {
  if (!exactKeys(data, UPDATE_CLAIM_KEYS)) return 'keys'
  const header = headerProblem(data)
  if (header) return header
  if (!isRevision(data.expectedRevision)) return 'expectedRevision'
  if (!Array.isArray(data.claimedToDate) || data.claimedToDate.length === 0 || data.claimedToDate.length > CLAIM_MAX_LINES) return 'claimedToDate'
  if (!data.claimedToDate.every(isAmount)) return 'claimedToDate'
  return null
}

export function approveClaimRequestProblem(data) {
  if (!exactKeys(data, APPROVE_CLAIM_KEYS)) return 'keys'
  if (!isId(data.projectId) || !isId(data.claimId)) return 'ids'
  if (!isRevision(data.expectedRevision)) return 'expectedRevision'
  if (!Array.isArray(data.approvedAmounts) || data.approvedAmounts.length === 0 || data.approvedAmounts.length > CLAIM_MAX_LINES) return 'approvedAmounts'
  if (!data.approvedAmounts.every(a => isAmount(a) && a >= 0 && isWholeCents(a))) return 'approvedAmounts'
  if (!isText(data.assessmentNotes, CLAIM_NOTES_MAX)) return 'assessmentNotes'
  return null
}

export function rejectClaimRequestProblem(data) {
  if (!exactKeys(data, REJECT_CLAIM_KEYS)) return 'keys'
  if (!isId(data.projectId) || !isId(data.claimId)) return 'ids'
  if (!isRevision(data.expectedRevision)) return 'expectedRevision'
  if (!isText(data.assessmentNotes, CLAIM_NOTES_MAX)) return 'assessmentNotes'
  return null
}

// ── The per-PO claim ledger ──────────────────────────────────────────────────

export const emptyPoClaimLedger = () => ({ seq: 0, openClaimIds: [], approvedPoLineCents: {}, approvedVariationLineCents: {} })

const isCents = (v) => Number.isSafeInteger(v) && v >= 0

export function storedPoClaimLedgerProblem(doc) {
  if (!doc) return null
  if (doc.seq !== undefined && !isCents(doc.seq)) return 'The claim ledger sequence is malformed.'
  if (doc.openClaimIds !== undefined && (!Array.isArray(doc.openClaimIds) || !doc.openClaimIds.every(isId))) return 'The claim ledger open-claim list is malformed.'
  for (const field of ['approvedPoLineCents', 'approvedVariationLineCents']) {
    if (doc[field] !== undefined && (!isObject(doc[field]) || !Object.values(doc[field]).every(isCents))) return `The claim ledger figure ${field} is malformed.`
  }
  return null
}

export function readPoClaimLedger(doc) {
  const out = emptyPoClaimLedger()
  if (!doc) return out
  out.seq = Number.isSafeInteger(doc.seq) ? doc.seq : 0
  out.openClaimIds = Array.isArray(doc.openClaimIds) ? [...doc.openClaimIds] : []
  out.approvedPoLineCents = { ...(doc.approvedPoLineCents ?? {}) }
  out.approvedVariationLineCents = { ...(doc.approvedVariationLineCents ?? {}) }
  if (doc.state === 'inconsistent') {
    out.state = 'inconsistent'
    out.problem = doc.problem ?? 'The purchase order’s claim history is inconsistent.'
    out.problemKind = doc.problemKind ?? 'malformed'
  }
  return out
}

export const variationLedgerKey = (variationId, lineIndex) => `${variationId}:${lineIndex}`

// The authoritative previously-approved cents of one claim line.
export function previouslyApprovedCents(ledger, line) {
  if (isVariationOriginLine(line)) return ledger.approvedVariationLineCents[variationLedgerKey(line.variationId, line.variationLineIndex)] ?? 0
  return ledger.approvedPoLineCents[String(line.poLineIndex)] ?? 0
}

export function poClaimLedgerDocument(L) {
  return { seq: L.seq, openClaimIds: L.openClaimIds, approvedPoLineCents: L.approvedPoLineCents, approvedVariationLineCents: L.approvedVariationLineCents }
}

// The PO claim ledgers of a project from its claim register (the baseline).
// Returns { problem } for a claim that cannot be attributed (no PO id), or
// { ledgers: Map poId → { state, problem, ledger, sources } }. Several open
// claims on one PO (possible before this boundary: DC36), or a certified
// amount that is not whole, non-negative cents, make that PO's ledger
// INCONSISTENT — refused for new claims until resolved, never repaired.
export function poClaimLedgersFromHistory(claims) {
  const byPo = new Map()
  const entry = (poId) => {
    if (!byPo.has(poId)) byPo.set(poId, { ledger: emptyPoClaimLedger(), problems: [], sources: { open: 0, approved: 0 } })
    return byPo.get(poId)
  }
  for (const c of claims ?? []) {
    if (!c) continue
    if (typeof c.poId !== 'string' || c.poId === '') return { problem: `${c.claimNumber || c.id} names no purchase order.` }
    const open = CLAIM_OPEN_STATUSES.includes(c.status)
    const approved = CLAIM_APPROVED_STATUSES.includes(c.status)
    if (!open && !approved) continue
    const e = entry(c.poId)
    if (open) { e.ledger.openClaimIds.push(c.id); e.sources.open += 1; continue }
    e.sources.approved += 1
    for (const li of Array.isArray(c.lineItems) ? c.lineItems : []) {
      const a = li?.approvedThisPeriod
      if (a == null) continue
      if (typeof a !== 'number' || !isWholeCents(a) || a < 0) { e.problems.push(`${c.claimNumber || c.id} stores a certified amount that is not whole, non-negative cents.`); continue }
      if (isVariationOriginLine(li)) {
        const idx = indexOrNull(li.variationLineIndex)
        if (idx === null) { e.problems.push(`${c.claimNumber || c.id} stores a variation line with no line index.`); continue }
        const key = variationLedgerKey(li.variationId, idx)
        e.ledger.approvedVariationLineCents[key] = (e.ledger.approvedVariationLineCents[key] ?? 0) + toCents(a)
      } else {
        const idx = indexOrNull(li.poLineIndex)
        if (idx === null) { e.problems.push(`${c.claimNumber || c.id} stores a line with no purchase-order line.`); continue }
        e.ledger.approvedPoLineCents[String(idx)] = (e.ledger.approvedPoLineCents[String(idx)] ?? 0) + toCents(a)
      }
    }
  }
  const ledgers = new Map()
  for (const [poId, e] of byPo) {
    e.ledger.openClaimIds.sort()
    let problem = e.problems[0] ?? null
    if (!problem && e.ledger.openClaimIds.length > 1) problem = `Several claims are open on this purchase order (${e.ledger.openClaimIds.length}); reject the extra ones before raising another.`
    const problemKind = !problem ? null : (e.problems.length > 0 ? 'malformed' : 'open-claims')
    ledgers.set(poId, { state: problem ? 'inconsistent' : 'established', problem, problemKind, ledger: e.ledger, sources: e.sources })
  }
  return { ledgers }
}

// ── Building claim lines on the server ───────────────────────────────────────

export const CLAIM_PROBLEM = {
  PO_INVALID:       'po-invalid',
  OPEN_CLAIM:       'open-claim',
  LINES_INVALID:    'lines-invalid',
  VARIATION_LINE:   'variation-line',
  DRAFT_INVALID:    'draft-invalid',
  OUT_OF_RANGE:     'out-of-range',
  FIGURES:          'figures-inconsistent',
  LEDGER:           'ledger-inconsistent',
}

const problem = (code, message, extra = {}) => ({ problem: code, message, ...extra })

// Re-derives a line set's period amounts under `version` over a ledger:
// `previouslyApproved` is the ledger's, `claimedToDate` the authored figure
// (rounded to whole cents under EXACT), `claimedThisPeriod` the difference.
function derivedLine(line, ledger, claimedToDate, version) {
  const prevCents = previouslyApprovedCents(ledger, line)
  const toDate = version === CALC_VERSION.EXACT ? fromCents(roundToCents(claimedToDate)) : claimedToDate
  const period = claimedThisPeriodFor(toDate, fromCents(prevCents), version)
  if (period === null) return null
  return { ...line, previouslyApproved: fromCents(prevCents), claimedToDate: toDate, claimedThisPeriod: period, approvedThisPeriod: null }
}

// The claim-line identity of the request's lines, from the PO and the
// variations the transaction read. Returns { lines } or a problem.
// Every PO line must appear exactly once, in order, before any variation line
// (the stored shape every claim has had since ADR-58 / ADR-63).
export function buildClaimSourceLines({ requestLines, po, variations }) {
  const poLines = Array.isArray(po?.lineItems) ? po.lineItems : []
  const poCount = requestLines.filter(l => l.variationId === null).length
  if (poCount !== poLines.length) return problem(CLAIM_PROBLEM.LINES_INVALID, 'A claim carries exactly one line for every purchase-order line.')
  const claimable = claimableNewScopeLines(variations.filter(Boolean), po)
  const lines = []
  for (const [i, r] of requestLines.entries()) {
    if (r.variationId === null) {
      if (r.poLineIndex !== i) return problem(CLAIM_PROBLEM.LINES_INVALID, 'Purchase-order lines must come first, in order.')
      lines.push(buildClaimLine(poLines[i], { poLineIndex: i, claimedToDate: r.claimedToDate, previouslyApproved: 0 }))
      continue
    }
    if (i < poLines.length) return problem(CLAIM_PROBLEM.LINES_INVALID, 'Variation lines come after the purchase-order lines.')
    const row = claimable.find(c => c.variationId === r.variationId && c.lineIndex === r.variationLineIndex)
    if (!row) {
      const variation = variations.find(v => v?.id === r.variationId) ?? null
      const issue = claimVariationLineIssue({ variationId: r.variationId, variationLineIndex: r.variationLineIndex }, { variation, po, classify: classifyCommitmentLines })
      return problem(CLAIM_PROBLEM.VARIATION_LINE, `Line ${i + 1}: ${CLAIM_VARIATION_LINE_ISSUE_LABELS[issue] ?? 'the variation line is not claimable new scope on this purchase order'}.`, { line: i })
    }
    lines.push(buildVariationClaimLine(row, { claimedToDate: r.claimedToDate, previouslyApproved: 0 }))
  }
  return { lines }
}

// The complete claim document a CREATE writes (stamps excepted — the backend
// adds server timestamps). Calculation version 2.
export function buildClaimDraft({ input, po, variations, ledger, uid, now, claimNumber, currency }) {
  if (!po || !CLAIMABLE_PO_STATUSES.includes(po.status)) return problem(CLAIM_PROBLEM.PO_INVALID, 'Claims can only be raised against a sent purchase order.')
  if (ledger.state === 'inconsistent') return problem(CLAIM_PROBLEM.LEDGER, ledger.problem)
  if (ledger.openClaimIds.length > 0) return problem(CLAIM_PROBLEM.OPEN_CLAIM, 'This purchase order already has an open claim.', { openClaimIds: ledger.openClaimIds })
  const built = buildClaimSourceLines({ requestLines: input.lines, po, variations })
  if (built.problem) return built
  const version = CURRENT_CALC_VERSION
  const lines = []
  for (const [i, line] of built.lines.entries()) {
    const d = derivedLine(line, ledger, input.lines[i].claimedToDate, version)
    if (!d) return problem(CLAIM_PROBLEM.OUT_OF_RANGE, `Line ${i + 1}: the amount is outside the supported range.`)
    lines.push(d)
  }
  const draftError = validateClaimDraft({ lineItems: lines, retention: input.retention, poId: po.id })
  if (draftError) return problem(CLAIM_PROBLEM.DRAFT_INVALID, draftError)
  const totals = claimTotalsFor(lines.map(l => l.claimedThisPeriod), input.retention, version)
  if (!totals) return problem(CLAIM_PROBLEM.OUT_OF_RANGE, 'The claim total is outside the supported range.')
  return {
    document: {
      claimNumber, status: CLAIM_STATUS.DRAFT, poId: po.id, poNumber: po.poNumber ?? null,
      supplierName: po.supplierName ?? '', supplierId: po.supplierId ?? null,
      claimRef: input.claimRef.trim(), periodEnding: input.periodEnding, variationId: null,
      variationLineCount: claimVariationLineCount(lines), lineItems: lines,
      retention: totals.retention, claimedSubtotal: totals.subtotal, claimedGst: totals.gst, claimedTotal: totals.total,
      approvedSubtotal: null, approvedGst: null, approvedTotal: null,
      notes: input.notes.trim(), assessmentNotes: '', currency, revision: 1, calcVersion: version,
      submittedAt: null, submittedBy: null, approvedAt: null, approvedBy: null, rejectedAt: null, rejectedBy: null, invoicedAt: null,
      ...CLAIM_LINK_INITIAL, externalRefs: {},
      createdAt: now, createdBy: uid, updatedAt: now, updatedBy: uid,
    },
  }
}

// A DRAFT EDIT: one claimed-to-date per STORED line (identity is the stored
// line's), previously-approved from the ledger, everything re-derived under
// the CURRENT version — an edited legacy draft becomes version 2 (the ADR-90
// correction policy, applied to claims).
export function buildClaimDraftUpdate({ input, live, ledger, uid, now }) {
  const stored = Array.isArray(live?.lineItems) ? live.lineItems : []
  if (input.claimedToDate.length !== stored.length) return problem(CLAIM_PROBLEM.LINES_INVALID, `A claimed-to-date value is required for every claim line (expected ${stored.length}).`)
  if (ledger.state === 'inconsistent') return problem(CLAIM_PROBLEM.LEDGER, ledger.problem)
  const identity = sourceLineIdentityError(stored, { poId: live.poId })
  if (identity) return problem(CLAIM_PROBLEM.LINES_INVALID, `${identity}. Reject this claim and raise it again.`)
  const version = CURRENT_CALC_VERSION
  const lines = []
  for (const [i, line] of stored.entries()) {
    const base = buildClaimLine(line, { claimedToDate: input.claimedToDate[i] })
    const d = derivedLine(base, ledger, input.claimedToDate[i], version)
    if (!d) return problem(CLAIM_PROBLEM.OUT_OF_RANGE, `Line ${i + 1}: the amount is outside the supported range.`)
    lines.push(d)
  }
  const draftError = validateClaimDraft({ lineItems: lines, retention: input.retention, poId: live.poId })
  if (draftError) return problem(CLAIM_PROBLEM.DRAFT_INVALID, draftError)
  const totals = claimTotalsFor(lines.map(l => l.claimedThisPeriod), input.retention, version)
  if (!totals) return problem(CLAIM_PROBLEM.OUT_OF_RANGE, 'The claim total is outside the supported range.')
  return {
    update: {
      claimRef: input.claimRef.trim(), periodEnding: input.periodEnding, notes: input.notes.trim(),
      lineItems: lines, retention: totals.retention, claimedSubtotal: totals.subtotal, claimedGst: totals.gst, claimedTotal: totals.total,
      calcVersion: version, revision: (Number(live.revision) || 0) + 1, updatedAt: now, updatedBy: uid,
    },
  }
}

// True when a stored draft already holds exactly what `update` would write
// (a repeat after a lost response).
export function claimDraftAlreadyHolds(live, update) {
  const keys = ['claimRef', 'periodEnding', 'notes', 'retention', 'claimedSubtotal', 'claimedGst', 'claimedTotal', 'calcVersion']
  if (!keys.every(k => live?.[k] === update[k])) return false
  return JSON.stringify(live.lineItems) === JSON.stringify(update.lineItems)
}

// ── Verification at the point a claim becomes authoritative ──────────────────
//
// Nothing stored is trusted at approval. A claim may have been written before
// this boundary existed, under Rules that cannot look inside its lines. So the
// submitted side is re-derived under the claim's OWN version against the
// purchase order, the variations and the ledger, and refused on any difference:
//   · every PO line present once, in order, with the PO line's cost code;
//   · every variation line still claimable new scope of an applied,
//     scope-committed variation on this PO, with its cost code and ceiling;
//   · previouslyApproved equal to the ledger's (no approval can have landed
//     while this claim was open — one open claim per PO);
//   · claimedThisPeriod = claimedToDate − previouslyApproved under the version;
//   · no certified figure present; the header the sum of the lines.
export function claimSubmittedSideProblem({ claim, po, variations, ledger }) {
  const version = calcVersionOf(claim)
  if (version === null) return problem(CLAIM_PROBLEM.FIGURES, 'The claim carries an unknown calculation version.', { reason: 'version' })
  const lines = Array.isArray(claim?.lineItems) ? claim.lineItems : []
  if (lines.length === 0) return problem(CLAIM_PROBLEM.FIGURES, 'The claim has no lines.', { reason: 'lines' })
  const identity = sourceLineIdentityError(lines, { poId: claim.poId })
  if (identity) return problem(CLAIM_PROBLEM.FIGURES, identity, { reason: 'identity' })
  const poLines = Array.isArray(po?.lineItems) ? po.lineItems : []
  const claimable = claimableNewScopeLines((variations ?? []).filter(Boolean), po)
  let poSeen = 0
  for (const [i, li] of lines.entries()) {
    const fail = (reason, message) => problem(CLAIM_PROBLEM.FIGURES, `Line ${i + 1} (${sourceLineLabel(li)}): ${message}`, { reason, line: i })
    if (isVariationOriginLine(li)) {
      const row = claimable.find(c => c.variationId === li.variationId && c.lineIndex === li.variationLineIndex)
      if (!row) return fail('variation-line', 'the variation line is not claimable new scope on this purchase order.')
      if (li.costCodeId !== row.costCodeId) return fail('cost-code', 'the cost code is not the variation line’s.')
      if (toCents(li.variationLineTotal) !== toCents(row.amount)) return fail('ceiling', 'the ceiling is not the variation line’s approved amount.')
    } else {
      if (li.poLineIndex !== poSeen || i !== poSeen) return fail('po-line', 'purchase-order lines are not complete and in order.')
      const pl = poLines[li.poLineIndex]
      if (!pl) return fail('po-line', 'the purchase order has no such line.')
      if (li.costCodeId !== pl.costCodeId) return fail('cost-code', 'the cost code is not the purchase-order line’s.')
      poSeen += 1
    }
    if (li.approvedThisPeriod != null) return fail('certified', 'a certified amount is already present.')
    if (toCents(li.previouslyApproved) !== previouslyApprovedCents(ledger, li)) return fail('previously-approved', 'the previously approved amount is not the purchase order’s certified total.')
    const period = claimedThisPeriodFor(li.claimedToDate, li.previouslyApproved, version)
    if (period === null || typeof li.claimedThisPeriod !== 'number' || toCents(li.claimedThisPeriod) !== toCents(period) || li.claimedThisPeriod !== period) {
      return fail('period', 'the amount claimed this period is not claimed-to-date less previously approved.')
    }
  }
  if (poSeen !== poLines.length) return problem(CLAIM_PROBLEM.FIGURES, 'The claim does not carry every purchase-order line.', { reason: 'po-line' })
  const totals = claimTotalsFor(lines.map(l => l.claimedThisPeriod), claim.retention, version)
  if (!totals) return problem(CLAIM_PROBLEM.FIGURES, 'The claim total is outside the supported range.', { reason: 'range' })
  const same = (a, b) => typeof a === 'number' && toCents(a) === toCents(b)
  if (!same(claim.retention, totals.retention) || !same(claim.claimedSubtotal, totals.subtotal) || !same(claim.claimedGst, totals.gst) || !same(claim.claimedTotal, totals.total)) {
    return problem(CLAIM_PROBLEM.FIGURES, 'The claim header is not the sum of its lines.', { reason: 'header' })
  }
  return null
}

// The approval update: certified lines, the approved header under the claim's
// OWN version, the notes, the link keys initialised (ADR-68).
export function buildClaimApproval({ claim, approvedAmounts, assessmentNotes, uid, now }) {
  const version = calcVersionOf(claim)
  const lines = claim.lineItems
  if (approvedAmounts.length !== lines.length) return problem(CLAIM_PROBLEM.LINES_INVALID, `A certified amount is required for every claim line (expected ${lines.length}).`)
  for (const [i, a] of approvedAmounts.entries()) {
    if (toCents(a) > toCents(lines[i].claimedThisPeriod)) return problem(CLAIM_PROBLEM.LINES_INVALID, `Line ${i + 1}: the certified amount cannot exceed the amount claimed.`)
  }
  const certified = lines.map((li, i) => ({ ...li, approvedThisPeriod: fromCents(toCents(approvedAmounts[i])) }))
  const totals = claimTotalsFor(certified.map(l => l.approvedThisPeriod), claim.retention, version)
  if (!totals) return problem(CLAIM_PROBLEM.OUT_OF_RANGE, 'The certified total is outside the supported range.')
  return {
    update: {
      status: CLAIM_STATUS.APPROVED, lineItems: certified,
      approvedSubtotal: totals.subtotal, approvedGst: totals.gst, approvedTotal: totals.total,
      assessmentNotes: assessmentNotes.trim(), approvedAt: now, approvedBy: uid,
      ...CLAIM_LINK_INITIAL,
      revision: (Number(claim.revision) || 0) + 1, updatedAt: now, updatedBy: uid,
    },
  }
}

// The ledger after approving `claim` (its certified lines) and closing it.
export function applyClaimApproval(ledger, claimId, certifiedLines) {
  const next = { ...ledger, seq: ledger.seq + 1, openClaimIds: ledger.openClaimIds.filter(id => id !== claimId),
    approvedPoLineCents: { ...ledger.approvedPoLineCents }, approvedVariationLineCents: { ...ledger.approvedVariationLineCents } }
  for (const li of certifiedLines) {
    const cents = toCents(li.approvedThisPeriod)
    if (isVariationOriginLine(li)) {
      const key = variationLedgerKey(li.variationId, li.variationLineIndex)
      next.approvedVariationLineCents[key] = (next.approvedVariationLineCents[key] ?? 0) + cents
    } else {
      const key = String(li.poLineIndex)
      next.approvedPoLineCents[key] = (next.approvedPoLineCents[key] ?? 0) + cents
    }
  }
  return next
}

export const applyClaimOpened = (ledger, claimId) => ({ ...ledger, seq: ledger.seq + 1, openClaimIds: [...ledger.openClaimIds.filter(id => id !== claimId), claimId].sort() })
export const applyClaimClosed = (ledger, claimId) => ({ ...ledger, seq: ledger.seq + 1, openClaimIds: ledger.openClaimIds.filter(id => id !== claimId) })

// True when a stored approved claim already holds this approval (a repeat).
export function sameClaimApproval(claim, uid, approvedAmounts) {
  if (claim?.status !== CLAIM_STATUS.APPROVED || claim.approvedBy !== uid) return false
  const lines = claim.lineItems ?? []
  return lines.length === approvedAmounts.length && lines.every((l, i) => toCents(l.approvedThisPeriod) === toCents(approvedAmounts[i]))
}

export const CLAIM_REJECTABLE_STATUSES = [CLAIM_STATUS.DRAFT, CLAIM_STATUS.SUBMITTED, CLAIM_STATUS.UNDER_REVIEW]
export const CLAIM_APPROVABLE_STATUSES = [CLAIM_STATUS.SUBMITTED, CLAIM_STATUS.UNDER_REVIEW]
