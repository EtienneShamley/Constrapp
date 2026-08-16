import { roundMoney } from './purchaseOrders'
import { isIsoDateShape, toCents } from './payments'
import { PO_SUPPLIER_TYPES } from './contacts'

// ── Tenders (packages, bids, comparison, award) ──────────────────────────────
//
// Tender V1 fills the gap between Estimate and Commitment: WHAT scope was put
// to market (a Tender Package of selected cost codes + free-text scope), WHO
// priced it (manually transcribed Tender Bids from supplier/subcontractor
// contacts), HOW the prices compare (the read-time Tender Comparison), and
// WHICH bid won (the award decision record on the package).
//
// ⚠️ AN AWARD IS A DECISION RECORD ONLY. It creates no Purchase Order, no
// budget line, no commitment, no actual, no forecast input, and no cash-flow
// line. Nothing in this module feeds Approved Budget, Committed, Claimed,
// Actual, Invoiced, Forecast, Margin, or Cash Flow — the comparison READS
// budget lines and writes nothing anywhere.
//
// ⚠️ NO STORED TOTALS — THE HEADER-VS-LINES DECISION. Bids store lineItems
// only; there is NO stored bidTotal and NO stored awardTotal. Firestore rules
// cannot iterate or sum an array, so a stored header total would be a second,
// unverifiable copy of the lines that a direct SDK call could set to anything
// (the exact integrity problem previously found in Credit Notes). Every total
// is derived at read time through assessBid() below, whose validity gate makes
// a malformed bid FAIL SAFELY — flagged and excluded — rather than silently
// influencing a comparison or an award figure.
//
// ⚠️ "TENDER COMPARISON", NEVER "BID LEVELLING". This module compares derived
// totals and per-cost-code amounts. It does no normalisation, no scope-gap
// pricing, and no item-level levelling — do not label it as levelling anywhere.

export const TENDER_COUNTER_ID = 'tenderPackages'

export const formatTenderNumber = (n) => `TP-${String(n).padStart(4, '0')}`

// ── Package lifecycle ────────────────────────────────────────────────────────
//
// Forward-only (ADR-11): draft → issued → awarded, with cancellation available
// until the award. Awarded and cancelled are both terminal — there is no
// un-award/rescind flow in V1, and financial-adjacent records are never
// deleted (ADR-12). These transitions are ALSO enforced by Firestore rules;
// this map is the client-side source of truth so UI and rules cannot drift.
export const TENDER_STATUS = {
  DRAFT:     'draft',
  ISSUED:    'issued',
  AWARDED:   'awarded',
  CANCELLED: 'cancelled',
}

export const TENDER_STATUS_LABELS = {
  [TENDER_STATUS.DRAFT]:     'Draft',
  [TENDER_STATUS.ISSUED]:    'Issued',
  [TENDER_STATUS.AWARDED]:   'Awarded',
  [TENDER_STATUS.CANCELLED]: 'Cancelled',
}

// Maps each status onto an existing Badge variant — no new colours.
export const TENDER_BADGE_VARIANTS = {
  [TENDER_STATUS.DRAFT]:     'soon',
  [TENDER_STATUS.ISSUED]:    'info',
  [TENDER_STATUS.AWARDED]:   'active',
  [TENDER_STATUS.CANCELLED]: 'danger',
}

export const TENDER_TRANSITIONS = {
  [TENDER_STATUS.DRAFT]:     [TENDER_STATUS.ISSUED, TENDER_STATUS.CANCELLED],
  [TENDER_STATUS.ISSUED]:    [TENDER_STATUS.AWARDED, TENDER_STATUS.CANCELLED],
  [TENDER_STATUS.AWARDED]:   [],
  [TENDER_STATUS.CANCELLED]: [],
}

export const canTenderTransition = (from, to) => (TENDER_TRANSITIONS[from] ?? []).includes(to)

// ── Bid lifecycle ────────────────────────────────────────────────────────────
//
// A bid is a TRANSCRIPTION of an external paper/email bid, not an authored
// document with a commit point — so it is created directly as `received` (no
// draft state, a deliberate, documented deviation from the create-draft-only
// standard, analogous to cashFlowLines' two-state simplification). A received
// bid stays correctable while the parent package is still ISSUED; once the
// package is awarded or cancelled every bid write is rejected by rules, which
// is what freezes the awarded bid's lines and makes the derived award value
// trustworthy.
export const BID_STATUS = {
  RECEIVED: 'received',
  VOID:     'void',
}

export const BID_STATUS_LABELS = {
  [BID_STATUS.RECEIVED]: 'Received',
  [BID_STATUS.VOID]:     'Void',
}

export const BID_BADGE_VARIANTS = {
  [BID_STATUS.RECEIVED]: 'info',
  [BID_STATUS.VOID]:     'danger',
}

export const BID_TRANSITIONS = {
  [BID_STATUS.RECEIVED]: [BID_STATUS.VOID],
  [BID_STATUS.VOID]:     [],
}

export const canBidTransition = (from, to) => (BID_TRANSITIONS[from] ?? []).includes(to)

// A bid is writable (edit or void) only while received AND its package is
// still issued. Mirrored by rules — this is the UX gate, rules are the boundary.
export const isBidWritable = (bid, pkg) =>
  bid?.status === BID_STATUS.RECEIVED && pkg?.status === TENDER_STATUS.ISSUED

// ── Bounds ───────────────────────────────────────────────────────────────────
//
// Bounds the embedded arrays so one document cannot approach Firestore's 1 MiB
// limit (the ADR-6 embedded-array trade-off). Mirrored in firestore.rules,
// which CAN check `.size()` even though it cannot inspect the elements.
export const MAX_PACKAGE_COST_CODES = 100
export const MAX_BID_LINES = 100

// ── Closing date ─────────────────────────────────────────────────────────────
//
// ⚠️ INFORMATIONAL ONLY. There is no trusted backend and no server clock, so
// nothing enforces closure: a bid CAN be recorded after this date, and the UI
// must say so wherever the date appears. Never describe closure as enforced.
export const CLOSING_DATE_NOTE =
  'Informational only — bids are not automatically blocked after the closing date.'

// ── Package helpers ──────────────────────────────────────────────────────────

export const packageCostCodeIds = (pkg) =>
  new Set((pkg?.costCodes ?? []).map(c => c?.costCodeId).filter(Boolean))

export const bidsForPackage = (bids, packageId) =>
  (bids ?? []).filter(b => b?.tenderPackageId === packageId)

export const receivedBidsForPackage = (bids, packageId) =>
  bidsForPackage(bids, packageId).filter(b => b.status === BID_STATUS.RECEIVED)

// ── Validation (client-enforced) ─────────────────────────────────────────────
//
// ⚠️ CLIENT-ENFORCED. Firestore rules validate the document SHAPE (lists,
// sizes, statuses, stamps) and the cross-document lifecycle gates, but they
// cannot iterate arrays — so element shape, cost-code containment, real
// cost-code existence, and bidder uniqueness live here only and can be
// bypassed by a direct SDK call (docs/SECURITY.md → Deferred Control 26).
// That is exactly why every derived figure passes through assessBid() below.

// Returns an error message, or null when the candidate package is saveable.
export function validateTenderPackageDraft({ name, costCodes, closingDate }) {
  if (!String(name || '').trim()) return 'Enter a package name.'
  const codes = Array.isArray(costCodes) ? costCodes : []
  if (codes.length === 0) {
    return 'Select at least one cost code — tender packages join the commercial lifecycle through the cost-code spine.'
  }
  if (codes.length > MAX_PACKAGE_COST_CODES) {
    return `A package cannot carry more than ${MAX_PACKAGE_COST_CODES} cost codes.`
  }
  const seen = new Set()
  for (const cc of codes) {
    if (typeof cc?.costCodeId !== 'string' || !cc.costCodeId) {
      return 'Every scope entry must reference a cost code.'
    }
    if (seen.has(cc.costCodeId)) return 'The same cost code is selected twice.'
    seen.add(cc.costCodeId)
    if (typeof cc?.costCodeName !== 'string' || !cc.costCodeName.trim()) {
      return 'Every scope entry needs its cost-code name snapshot.'
    }
  }
  if (closingDate && !isIsoDateShape(closingDate)) {
    return 'Closing date must be a valid date (or left blank).'
  }
  return null
}

// One ACTIVE (received) bid per bidder per package is desirable but only
// client-checkable: bid ids are random and rules have no queries, so two
// simultaneous creators can still duplicate (the Deferred Control 9 posture).
// Returns the conflicting bid, or null.
export function duplicateActiveBid(bids, { tenderPackageId, bidderContactId, excludeBidId = null }) {
  return (bids ?? []).find(b =>
    b.id !== excludeBidId
    && b.tenderPackageId === tenderPackageId
    && b.bidderContactId === bidderContactId
    && b.status === BID_STATUS.RECEIVED,
  ) ?? null
}

// Returns an error message, or null when the candidate bid is saveable.
// `contacts` and `bids` are optional cross-checks (pass the live lists).
export function validateBidDraft({
  tenderPackage, bidderContactId, bidderName, bidDate, lineItems,
  contacts = null, bids = null, excludeBidId = null,
}) {
  if (!tenderPackage) return 'Select a tender package.'
  if (tenderPackage.status !== TENDER_STATUS.ISSUED) {
    return 'Bids can only be recorded against an issued package.'
  }
  if (!bidderContactId) return 'Select the bidder.'
  if (!String(bidderName || '').trim()) return 'The bidder name snapshot is missing.'
  if (contacts) {
    const contact = contacts.find(c => c.id === bidderContactId) ?? null
    if (!contact) return 'The selected bidder does not exist in Contacts.'
    const types = contact.contactTypes ?? []
    if (!PO_SUPPLIER_TYPES.some(t => types.includes(t))) {
      return 'The bidder must be a supplier or subcontractor contact.'
    }
  }
  if (!isIsoDateShape(bidDate)) return 'Enter the date the bid was received.'

  const lines = Array.isArray(lineItems) ? lineItems : []
  if (lines.length === 0) return 'Enter at least one priced line.'
  if (lines.length > MAX_BID_LINES) return `A bid cannot carry more than ${MAX_BID_LINES} lines.`

  const inScope = packageCostCodeIds(tenderPackage)
  for (let i = 0; i < lines.length; i++) {
    const li = lines[i]
    if (!li?.costCodeId) return `Line ${i + 1}: choose a cost code.`
    if (!inScope.has(li.costCodeId)) {
      return `Line ${i + 1}: the cost code is not in this package's scope.`
    }
    const amt = Number(li.amount)
    if (!Number.isFinite(amt)) return `Line ${i + 1}: amount must be a number.`
    if (amt < 0) return `Line ${i + 1}: amount cannot be negative.`
  }

  if (bids) {
    const dup = duplicateActiveBid(bids, {
      tenderPackageId: tenderPackage.id, bidderContactId, excludeBidId,
    })
    if (dup) {
      return `${dup.bidderName || 'This bidder'} already has an active bid on this package — void it before recording a replacement.`
    }
  }
  return null
}

// ── THE bid validity gate (central, read-time) ───────────────────────────────
//
// Every financial use of a bid — its total, the comparison, the award display
// value — passes through here. Rules cannot iterate lineItems, so a direct SDK
// caller can store malformed embedded line data; this gate is what makes such
// a document FAIL SAFELY instead of being trusted.
//
// A bid is VALID only when every line has: a real object shape, a non-empty
// costCodeId contained in the package scope, string costCodeName/description,
// and a finite numeric amount ≥ 0 (zero is a legitimate price). If ANY line is
// malformed the WHOLE bid is invalid: total is null (never a partial sum,
// never $0, never clamped), and the bid is excluded from lowest-bid ranking
// and budget comparison while remaining visible and flagged for audit.

const lineProblemList = (li, inScope) => {
  if (typeof li !== 'object' || li === null || Array.isArray(li)) {
    return ['not a line object']
  }
  const problems = []
  if (typeof li.costCodeId !== 'string' || !li.costCodeId) {
    problems.push('missing cost code')
  } else if (!inScope.has(li.costCodeId)) {
    problems.push('cost code outside the package scope')
  }
  if (typeof li.costCodeName !== 'string') problems.push('missing cost-code name snapshot')
  if (typeof li.description !== 'string') problems.push('missing description')
  if (typeof li.amount !== 'number' || !Number.isFinite(li.amount)) {
    problems.push('amount is not a finite number')
  } else if (li.amount < 0) {
    problems.push('negative amount')
  }
  return problems
}

// → { valid, total (number | null), lineProblems: string[][], problems: string[] }
export function assessBid(bid, pkg) {
  const lines = bid?.lineItems
  if (!Array.isArray(lines) || lines.length === 0) {
    return {
      valid: false,
      total: null,
      lineProblems: [],
      problems: ['This bid has no priced line items.'],
    }
  }
  const inScope = packageCostCodeIds(pkg)
  const lineProblems = lines.map(li => lineProblemList(li, inScope))
  if (lineProblems.some(p => p.length > 0)) {
    return {
      valid: false,
      total: null,
      lineProblems,
      problems: ['One or more line items are malformed — this bid is excluded from totals, comparison, and award.'],
    }
  }
  // ⚠️ THE SUM ITSELF MUST BE FINITE. Every line can be a finite number and the
  // TOTAL can still overflow to Infinity (1e308 + 1e308, or a single 1e308 once
  // roundMoney multiplies by 100). A non-finite total would pass this gate as
  // "valid" while producing -Infinity budget variances, a NaN variance-to-lowest,
  // a LOWEST flag, and an awardable bid whose figures merely render as "—". The
  // gate's promise is a TRUSTWORTHY total, so an unrepresentable sum invalidates
  // the whole bid exactly like a malformed line — never a partial sum, never $0.
  const total = roundMoney(lines.reduce((sum, li) => sum + li.amount, 0))
  if (!Number.isFinite(total)) {
    return {
      valid: false,
      total: null,
      lineProblems,
      problems: ['The line amounts total beyond the range this app can represent — this bid is excluded from totals, comparison, and award.'],
    }
  }
  return {
    valid: true,
    total,
    lineProblems,
    problems: [],
  }
}

// Derived bid total ex-GST, or null when the bid fails the validity gate.
export const bidTotalExGst = (bid, pkg) => assessBid(bid, pkg).total

// ── Approved Budget for a package's cost codes (read-time) ───────────────────
//
// Σ budgetLines.budgeted over the package's selected cost codes. When NO budget
// line exists for any of them, `hasBudget` is false and `amount` is null — the
// comparison shows "no budget", it never compares against zero.
export function approvedBudgetForPackage(pkg, budgetLines) {
  const inScope = packageCostCodeIds(pkg)
  let amount = 0
  let hasBudget = false
  for (const line of budgetLines ?? []) {
    if (!line?.costCodeId || !inScope.has(line.costCodeId)) continue
    hasBudget = true
    amount = roundMoney(amount + (Number(line.budgeted) || 0))
  }
  return { amount: hasBudget ? amount : null, hasBudget }
}

// ── TENDER COMPARISON (read-time; nothing stored) ────────────────────────────
//
// Sign convention (Constrapp-wide, matching Variance to Budget on Forecast):
//
//     Variance to Budget = Approved Budget − Bid
//     POSITIVE = bid under budget · NEGATIVE = bid over budget
//
// Variance to lowest = Bid − lowest valid bid (0 for the lowest; positive =
// amount above the lowest). Void and invalid bids stay visible for audit but
// are EXCLUDED from the ranking set, the lowest-bid figure, and every variance.
export function buildTenderComparison({ pkg, bids, budgetLines }) {
  const budget = approvedBudgetForPackage(pkg, budgetLines)

  const rows = bidsForPackage(bids, pkg?.id).map(bid => {
    const assessment = assessBid(bid, pkg)
    return {
      bidId:         bid.id,
      bidderName:    bid.bidderName || '',
      bidDate:       bid.bidDate || '',
      bidderRef:     bid.bidderRef || '',
      status:        bid.status,
      isVoid:        bid.status === BID_STATUS.VOID,
      isAwarded:     pkg?.awardedBidId === bid.id,
      valid:         assessment.valid,
      problems:      assessment.problems,
      lineProblems:  assessment.lineProblems,
      total:         assessment.total,       // null when invalid — never 0
      exclusions:    bid.exclusions || '',
      hasExclusions: !!String(bid.exclusions || '').trim(),
      notes:         bid.notes || '',
      hasNotes:      !!String(bid.notes || '').trim(),
      varianceToBudget: null,
      varianceToLowest: null,
      isLowest:         false,
    }
  })

  const ranked = rows.filter(r => r.valid && !r.isVoid)
  const lowest = ranked.length ? Math.min(...ranked.map(r => r.total)) : null

  for (const r of ranked) {
    r.varianceToBudget = budget.hasBudget ? roundMoney(budget.amount - r.total) : null
    r.varianceToLowest = roundMoney(r.total - lowest)
    // Compared in whole cents so a tie for lowest flags every tied bid.
    r.isLowest = toCents(r.total) === toCents(lowest)
  }

  return {
    rows: [
      ...ranked.slice().sort((a, b) => a.total - b.total),
      ...rows.filter(r => !r.valid && !r.isVoid),
      ...rows.filter(r => r.isVoid),
    ],
    budget,
    lowest,
    rankedCount: ranked.length,
  }
}

// Per-cost-code comparison matrix: one row per package cost code, one column
// per VALID received bid (invalid/void bids are excluded from every comparison
// calculation). Cell = Σ that bid's line amounts on that cost code.
// Still Tender Comparison — no normalisation, no levelling.
export function costCodeComparisonMatrix({ pkg, bids }) {
  const columns = bidsForPackage(bids, pkg?.id)
    .filter(b => b.status === BID_STATUS.RECEIVED && assessBid(b, pkg).valid)
    .map(b => ({ bidId: b.id, bidderName: b.bidderName || '' }))

  const byBid = new Map(bidsForPackage(bids, pkg?.id).map(b => [b.id, b]))

  const rows = (pkg?.costCodes ?? []).map(cc => {
    const amounts = {}
    for (const col of columns) {
      const bid = byBid.get(col.bidId)
      let sum = null
      for (const li of bid?.lineItems ?? []) {
        if (li?.costCodeId !== cc.costCodeId) continue
        sum = roundMoney((sum ?? 0) + li.amount)
      }
      amounts[col.bidId] = sum // null = this bid priced nothing on the code
    }
    return { costCodeId: cc.costCodeId, costCodeName: cc.costCodeName, amounts }
  })

  return { columns, rows }
}

// ── Award (decision record only) ─────────────────────────────────────────────

// UI gate for the award action. The same conditions (minus the validity gate,
// which rules cannot express) are rules-enforced; this is the UX mirror.
// Returns the blocking reason, or null when awarding is permitted.
export function awardBlockedReason(pkg, bid) {
  if (!pkg || pkg.status !== TENDER_STATUS.ISSUED) return 'Only an issued package can be awarded.'
  if (!bid) return 'Select a bid to award.'
  if (bid.tenderPackageId !== pkg.id) return 'That bid belongs to a different package.'
  if (bid.status !== BID_STATUS.RECEIVED) return 'A void bid cannot be awarded.'
  if (!assessBid(bid, pkg).valid) {
    return 'This bid has malformed line items and cannot be awarded until it is corrected.'
  }
  return null
}

// The AWARDED BID VALUE shown on the Tender pages: derived at read time from
// the frozen awarded bid's lineItems (no stored awardTotal exists — see the
// header note). `available` is false when the package is not awarded, the bid
// document cannot be found, or the bid fails the validity gate.
//
// ⚠️ A TENDER DECISION VALUE ONLY. It is never netted against Purchase Orders
// (V1 has no explicit Award → PO linkage, so any "awarded but not committed"
// arithmetic would be wrong whenever packages share cost codes or POs span
// packages) and it feeds no financial derivation.
export function awardedBidValue(pkg, bids) {
  if (pkg?.status !== TENDER_STATUS.AWARDED || !pkg?.awardedBidId) {
    return { available: false, total: null, bid: null }
  }
  const bid = (bids ?? []).find(b => b.id === pkg.awardedBidId) ?? null
  if (!bid) return { available: false, total: null, bid: null }
  const assessment = assessBid(bid, pkg)
  return { available: assessment.valid, total: assessment.total, bid }
}
