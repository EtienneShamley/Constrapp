import { roundMoney } from './purchaseOrders'

// ── Approved Budget ADJUSTMENTS — Constrapp SHIELD™ 2B2 (ADR-71) ─────────────
//
// Pure domain logic for a controlled movement of the APPROVED budget between
// full re-approvals. No Firestore, no React.
//
// THE MODEL
//
//   budgetAdjustments/{adjustmentId}   ONE movement — increase | decrease of
//                                      one cost code, or a transfer from one
//                                      cost code to another — of a POSITIVE
//                                      whole-cent amount, bound at creation to
//                                      the ACTIVE approved version
//                                      (baseApprovalId / baseVersion).
//                                      draft → approved | withdrawn, both
//                                      terminal; never edited, never deleted.
//   approvedBudget/current             gains an OPTIONAL ledger of the active
//                                      version: adjustmentCount (+1 per
//                                      approval), adjustmentNet (signed Σ),
//                                      lastAdjustmentId. Absent reads 0. A
//                                      full re-approval RESETS it to 0.
//
// ⚠️ CURRENT ADJUSTED APPROVED BUDGET =
//      Σ ACTIVE snapshot entries
//    + Σ signed movements of APPROVED adjustments whose baseApprovalId IS the
//      pointer's activeApprovalId.
// An adjustment bound to an older version is SUPERSEDED by the version that
// replaced it and never counts again — that, plus the ledger reset, is what
// makes double counting structurally impossible (ADR-71). The records are the
// figure; the pointer ledger is a rules-maintained cross-check.
//
// The signed net is DERIVED, never stored: increase +amount, decrease
// −amount, transfer 0 (−amount on the source, +amount on the destination).
// A correction is a SEPARATE, approved compensating adjustment.
//
// What rules cannot prove (SECURITY.md → Deferred Control 45): that no cost
// code's accumulated adjusted figure goes below zero (a sibling sum), that a
// reason or reference is meaningful, that two drafts are not the same
// movement in substance, and that a re-approval reviewer understood the
// supersession they acknowledged.

export const BUDGET_ADJUSTMENT_TYPE = {
  INCREASE: 'increase',
  DECREASE: 'decrease',
  TRANSFER: 'transfer',
}

export const BUDGET_ADJUSTMENT_TYPES = [
  BUDGET_ADJUSTMENT_TYPE.INCREASE, BUDGET_ADJUSTMENT_TYPE.DECREASE, BUDGET_ADJUSTMENT_TYPE.TRANSFER,
]

export const BUDGET_ADJUSTMENT_TYPE_LABELS = {
  [BUDGET_ADJUSTMENT_TYPE.INCREASE]: 'Increase',
  [BUDGET_ADJUSTMENT_TYPE.DECREASE]: 'Decrease',
  [BUDGET_ADJUSTMENT_TYPE.TRANSFER]: 'Transfer',
}

export const BUDGET_ADJUSTMENT_TYPE_HINTS = {
  [BUDGET_ADJUSTMENT_TYPE.INCREASE]: 'Adds authorised budget to one cost code. The project total rises.',
  [BUDGET_ADJUSTMENT_TYPE.DECREASE]: 'Removes authorised budget from one cost code. The project total falls.',
  [BUDGET_ADJUSTMENT_TYPE.TRANSFER]: 'Moves budget from one cost code to another — including a contingency reallocation. The project total is unchanged.',
}

export const BUDGET_ADJUSTMENT_STATUS = {
  DRAFT:     'draft',
  APPROVED:  'approved',
  WITHDRAWN: 'withdrawn',
}

export const BUDGET_ADJUSTMENT_STATUS_LABELS = {
  [BUDGET_ADJUSTMENT_STATUS.DRAFT]:     'Draft',
  [BUDGET_ADJUSTMENT_STATUS.APPROVED]:  'Approved',
  [BUDGET_ADJUSTMENT_STATUS.WITHDRAWN]: 'Withdrawn',
}

// The existing semantic Badge variants (DESIGN_SYSTEM.md), as for versions.
export const BUDGET_ADJUSTMENT_STATUS_BADGE = {
  [BUDGET_ADJUSTMENT_STATUS.DRAFT]:     'soon',
  [BUDGET_ADJUSTMENT_STATUS.APPROVED]:  'active',
  [BUDGET_ADJUSTMENT_STATUS.WITHDRAWN]: 'danger',
}

// draft → approved, draft → withdrawn. Both TERMINAL.
export function canBudgetAdjustmentTransition(from, to) {
  if (from !== BUDGET_ADJUSTMENT_STATUS.DRAFT) return false
  return to === BUDGET_ADJUSTMENT_STATUS.APPROVED || to === BUDGET_ADJUSTMENT_STATUS.WITHDRAWN
}

export const BUDGET_ADJUSTMENT_LIMITS = {
  reason: 500,
  reference: 200,
  withdrawReason: 500,
  costCodeName: 170,
  // Exclusive upper bound (rules-pinned): an amount must be below this.
  amountCeiling: 1_000_000_000_000,
}

export const BUDGET_ADJUSTMENT_KEYS = [
  'type', 'costCodeId', 'costCodeName', 'fromCostCodeId', 'fromCostCodeName', 'amount', 'currency',
  'reason', 'reference', 'baseApprovalId', 'baseVersion', 'sequence', 'status',
  'approvedAt', 'approvedBy', 'withdrawnAt', 'withdrawnBy', 'withdrawReason',
  'revision', 'createdAt', 'createdBy', 'updatedAt', 'updatedBy',
]

// ── Roles (UX mirrors — Firestore rules are the enforced boundary) ───────────
// The SAME audiences as a budget version (ADR-70): any financial role
// prepares; company_admin / project_manager approve; a draft is withdrawn by
// an approver or its preparer. Self-approval is permitted and shown.
// (Declared here, equal to lib/budgetApproval.js's lists, so the adapter can
// import this module without an import cycle; a unit test pins the equality.)
export const BUDGET_ADJUSTMENT_PREPARE_ROLES = ['company_admin', 'project_manager', 'qs']
export const BUDGET_ADJUSTMENT_APPROVE_ROLES = ['company_admin', 'project_manager']

export const canPrepareBudgetAdjustment = (role) => BUDGET_ADJUSTMENT_PREPARE_ROLES.includes(role)
export const canApproveBudgetAdjustment = (role) => BUDGET_ADJUSTMENT_APPROVE_ROLES.includes(role)
export const canWithdrawBudgetAdjustment = (role, adjustment, uid) =>
  canApproveBudgetAdjustment(role)
  || (canPrepareBudgetAdjustment(role) && Boolean(uid) && adjustment?.createdBy === uid)

// ── Money ────────────────────────────────────────────────────────────────────

const isMoney = (v) => typeof v === 'number' && Number.isFinite(v)
const toCents = (n) => Math.round((Number(n) || 0) * 100)

// A POSITIVE amount of at most two decimal places, below the ceiling. This is
// the exact client mirror of the rules pin `cents(a) / 100.0 == a`
// (math.round(a * 100) / 100.0 == a), proven against boundary values in the
// emulator (tests/rules/budgetAdjustments.rules.test.js).
export const isAdjustmentAmount = (v) =>
  isMoney(v) && v > 0 && v < BUDGET_ADJUSTMENT_LIMITS.amountCeiling && Math.round(v * 100) / 100 === v

// The signed effect on the PROJECT total: +amount, −amount, or 0 for a
// transfer. null for a malformed record (never a silent 0).
export function adjustmentNet(adj) {
  if (!adj || !isAdjustmentAmount(adj.amount)) return null
  if (adj.type === BUDGET_ADJUSTMENT_TYPE.INCREASE) return adj.amount
  if (adj.type === BUDGET_ADJUSTMENT_TYPE.DECREASE) return -adj.amount
  if (adj.type === BUDGET_ADJUSTMENT_TYPE.TRANSFER) return 0
  return null
}

// The signed movement per cost code — ONE entry for increase / decrease, TWO
// for a transfer (−source, +destination). Empty for a malformed record.
export function adjustmentMovements(adj) {
  if (validateBudgetAdjustmentRecord(adj) !== null) return []
  if (adj.type === BUDGET_ADJUSTMENT_TYPE.INCREASE) {
    return [{ costCodeId: adj.costCodeId, costCodeName: adj.costCodeName, amount: adj.amount }]
  }
  if (adj.type === BUDGET_ADJUSTMENT_TYPE.DECREASE) {
    return [{ costCodeId: adj.costCodeId, costCodeName: adj.costCodeName, amount: -adj.amount }]
  }
  return [
    { costCodeId: adj.fromCostCodeId, costCodeName: adj.fromCostCodeName, amount: -adj.amount },
    { costCodeId: adj.costCodeId, costCodeName: adj.costCodeName, amount: adj.amount },
  ]
}

// Σ signed movements of the given adjustments, per cost code (whole-cent sums).
export function movementsByCostCode(adjustments) {
  const map = {}
  for (const adj of adjustments ?? []) {
    for (const m of adjustmentMovements(adj)) {
      map[m.costCodeId] = roundMoney((map[m.costCodeId] || 0) + m.amount)
    }
  }
  return map
}

// `perCode` plus the movements, a NEW map (whole-cent sums).
export function applyMovements(perCode, adjustments) {
  const out = { ...(perCode ?? {}) }
  const moves = movementsByCostCode(adjustments)
  for (const [id, amount] of Object.entries(moves)) out[id] = roundMoney((out[id] || 0) + amount)
  return out
}

// ── Record validation (read-time; the client completeness rules cannot give) ─

// Returns null when the record is a well-formed movement, else the reason.
export function validateBudgetAdjustmentRecord(adj) {
  const a = adj ?? {}
  if (!BUDGET_ADJUSTMENT_TYPES.includes(a.type)) return 'has an unknown adjustment type'
  if (typeof a.costCodeId !== 'string' || !a.costCodeId) return 'has no cost code'
  if (typeof a.costCodeName !== 'string' || a.costCodeName.length > BUDGET_ADJUSTMENT_LIMITS.costCodeName) return 'has a malformed cost-code name'
  if (a.type === BUDGET_ADJUSTMENT_TYPE.TRANSFER) {
    if (typeof a.fromCostCodeId !== 'string' || !a.fromCostCodeId) return 'is a transfer with no source cost code'
    if (a.fromCostCodeId === a.costCodeId) return 'is a transfer to the same cost code'
    if (typeof a.fromCostCodeName !== 'string' || a.fromCostCodeName.length > BUDGET_ADJUSTMENT_LIMITS.costCodeName) return 'has a malformed source cost-code name'
  } else if (a.fromCostCodeId !== null && a.fromCostCodeId !== undefined) {
    return 'names a source cost code but is not a transfer'
  }
  if (!isAdjustmentAmount(a.amount)) return 'has an amount that is not a positive whole-cent number'
  if (typeof a.currency !== 'string' || !/^[A-Z]{3}$/.test(a.currency)) return 'has no valid currency'
  if (typeof a.baseApprovalId !== 'string' || !a.baseApprovalId) return 'is not bound to an approved version'
  return null
}

// ── Draft input ──────────────────────────────────────────────────────────────

const trimTo = (v, max) => String(v ?? '').trim().slice(0, max)

// Parses an amount the way the form holds it (a string or a number). Never
// rounds: an amount with a third decimal is REFUSED, not repaired.
export function parseAdjustmentAmount(v) {
  if (typeof v === 'number') return v
  const s = String(v ?? '').trim().replace(/,/g, '')
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return NaN
  return Number(s)
}

// `costCodeById` is the company cost-code library (Map or object). A cost
// code must exist; preparation offers ACTIVE codes, but an inactive code a
// budget already carries remains valid as a SOURCE (it may hold budget).
export function validateBudgetAdjustmentDraft(input, costCodeById = null) {
  const i = input ?? {}
  if (!BUDGET_ADJUSTMENT_TYPES.includes(i.type)) return 'Choose an adjustment type'
  const amount = parseAdjustmentAmount(i.amount)
  if (!Number.isFinite(amount)) return 'Enter an amount with at most two decimal places'
  if (!isAdjustmentAmount(amount)) return 'Enter a positive amount with at most two decimal places'
  const lookup = (id) => (costCodeById instanceof Map ? costCodeById.get(id) : costCodeById?.[id])
  if (!i.costCodeId) return i.type === BUDGET_ADJUSTMENT_TYPE.TRANSFER ? 'Choose the cost code to transfer to' : 'Choose a cost code'
  if (costCodeById && !lookup(i.costCodeId)) return 'The chosen cost code does not exist'
  if (i.type === BUDGET_ADJUSTMENT_TYPE.TRANSFER) {
    if (!i.fromCostCodeId) return 'Choose the cost code to transfer from'
    if (i.fromCostCodeId === i.costCodeId) return 'A transfer must move budget between two different cost codes'
    if (costCodeById && !lookup(i.fromCostCodeId)) return 'The source cost code does not exist'
  }
  const reason = String(i.reason ?? '').trim()
  if (!reason) return 'Enter the reason for this adjustment'
  if (reason.length > BUDGET_ADJUSTMENT_LIMITS.reason) return `The reason must be ${BUDGET_ADJUSTMENT_LIMITS.reason} characters or fewer`
  if (String(i.reference ?? '').trim().length > BUDGET_ADJUSTMENT_LIMITS.reference) {
    return `The reference must be ${BUDGET_ADJUSTMENT_LIMITS.reference} characters or fewer`
  }
  return null
}

export function validateBudgetAdjustmentWithdrawReason(reason) {
  const r = String(reason ?? '').trim()
  if (!r) return 'Enter a reason for withdrawing this draft'
  if (r.length > BUDGET_ADJUSTMENT_LIMITS.withdrawReason) return `The reason must be ${BUDGET_ADJUSTMENT_LIMITS.withdrawReason} characters or fewer`
  return null
}

// The cost-code display name frozen onto the record (the same "code — name"
// form a budget line snapshots).
export function adjustmentCostCodeName(cc) {
  if (!cc) return ''
  const code = String(cc.code ?? '').trim()
  const name = String(cc.name ?? '').trim()
  return (code && name ? `${code} — ${name}` : (code || name)).slice(0, BUDGET_ADJUSTMENT_LIMITS.costCodeName)
}

// The movement fields exactly as stored (no stamps, no lifecycle). Call only
// after validateBudgetAdjustmentDraft returned null.
export function normaliseBudgetAdjustmentDraft(input, costCodeById = null) {
  const i = input ?? {}
  const lookup = (id) => (costCodeById instanceof Map ? costCodeById.get(id) : costCodeById?.[id])
  const transfer = i.type === BUDGET_ADJUSTMENT_TYPE.TRANSFER
  return {
    type: i.type,
    costCodeId: i.costCodeId,
    costCodeName: adjustmentCostCodeName(lookup(i.costCodeId)),
    fromCostCodeId: transfer ? i.fromCostCodeId : null,
    fromCostCodeName: transfer ? adjustmentCostCodeName(lookup(i.fromCostCodeId)) : '',
    amount: parseAdjustmentAmount(i.amount),
    reason: trimTo(i.reason, BUDGET_ADJUSTMENT_LIMITS.reason),
    reference: trimTo(i.reference, BUDGET_ADJUSTMENT_LIMITS.reference),
  }
}

// ── Resulting-balance preview ────────────────────────────────────────────────
//
// What the adjusted approved figure of each AFFECTED cost code becomes if
// `adj` is approved on top of `perCode` (the CURRENT adjusted per-code map
// from the shared adapter). A resulting figure below zero is REFUSED — the
// approve transaction re-runs this against a fresh server read.
export function adjustmentPreview(perCode, adj) {
  const moves = adjustmentMovements(adj)
  const rows = moves.map(m => {
    const before = roundMoney(perCode?.[m.costCodeId] || 0)
    const after = roundMoney(before + m.amount)
    return { costCodeId: m.costCodeId, costCodeName: m.costCodeName, before, change: m.amount, after, negative: toCents(after) < 0 }
  })
  const net = adjustmentNet(adj)
  return {
    ok: rows.length > 0 && rows.every(r => !r.negative),
    rows,
    net,
    negative: rows.filter(r => r.negative),
  }
}

// ── Lists, labels, staleness ─────────────────────────────────────────────────

const tsMillis = (t) => {
  if (!t) return null
  if (typeof t.toMillis === 'function') return t.toMillis()
  if (typeof t.seconds === 'number') return t.seconds * 1000 + Math.floor((t.nanoseconds ?? 0) / 1e6)
  if (typeof t === 'number') return t
  return null
}

// A DRAFT whose base is no longer the active version: withdraw-only. Its
// movement was prepared against figures that a re-approval has replaced.
export const isStaleBudgetAdjustment = (adj, activeApprovalId) =>
  adj?.status === BUDGET_ADJUSTMENT_STATUS.DRAFT && Boolean(activeApprovalId) && adj.baseApprovalId !== activeApprovalId

// An APPROVED adjustment of an older version: history, superseded.
export const isSupersededBudgetAdjustment = (adj, activeApprovalId) =>
  adj?.status === BUDGET_ADJUSTMENT_STATUS.APPROVED && Boolean(activeApprovalId) && adj.baseApprovalId !== activeApprovalId

export const approvedAdjustmentsFor = (adjustments, baseApprovalId) =>
  (adjustments ?? []).filter(a => a?.status === BUDGET_ADJUSTMENT_STATUS.APPROVED && a.baseApprovalId === baseApprovalId)
    .sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0))

export const draftAdjustmentsFor = (adjustments, baseApprovalId) =>
  (adjustments ?? []).filter(a => a?.status === BUDGET_ADJUSTMENT_STATUS.DRAFT && a.baseApprovalId === baseApprovalId)
    .sort((a, b) => (tsMillis(a.createdAt) ?? 0) - (tsMillis(b.createdAt) ?? 0))

// Panel order: newest base first; within a base, drafts, then approved by
// sequence descending, then withdrawn — newest first.
export function budgetAdjustmentHistory(adjustments) {
  const rank = { [BUDGET_ADJUSTMENT_STATUS.DRAFT]: 0, [BUDGET_ADJUSTMENT_STATUS.APPROVED]: 1, [BUDGET_ADJUSTMENT_STATUS.WITHDRAWN]: 2 }
  return [...(adjustments ?? [])].sort((a, b) => {
    const v = (b?.baseVersion ?? 0) - (a?.baseVersion ?? 0)
    if (v !== 0) return v
    const r = (rank[a?.status] ?? 3) - (rank[b?.status] ?? 3)
    if (r !== 0) return r
    if (a?.status === BUDGET_ADJUSTMENT_STATUS.APPROVED) return (b.sequence ?? 0) - (a.sequence ?? 0)
    return (tsMillis(b?.createdAt) ?? 0) - (tsMillis(a?.createdAt) ?? 0)
  })
}

export function budgetAdjustmentLabel(adj) {
  if (!adj) return ''
  const base = Number.isInteger(adj.baseVersion) ? `v${adj.baseVersion}` : 'v?'
  if (adj.status === BUDGET_ADJUSTMENT_STATUS.APPROVED) return `${base} · Adjustment ${adj.sequence ?? '?'}`
  return adj.status === BUDGET_ADJUSTMENT_STATUS.DRAFT ? `${base} · Draft adjustment` : `${base} · Withdrawn draft`
}

// "Concrete +$5,000" / "Formwork → Concrete $5,000" — the movement in words.
export function budgetAdjustmentMovementText(adj, money = (n) => String(n)) {
  if (!adj) return ''
  if (adj.type === BUDGET_ADJUSTMENT_TYPE.TRANSFER) {
    return `${adj.fromCostCodeName || adj.fromCostCodeId} → ${adj.costCodeName || adj.costCodeId} · ${money(adj.amount)}`
  }
  const sign = adj.type === BUDGET_ADJUSTMENT_TYPE.DECREASE ? '−' : '+'
  return `${adj.costCodeName || adj.costCodeId} · ${sign}${money(adj.amount)}`
}

// Pending DRAFTS of the active version: how many, and their combined effect
// on the project total if every one were approved. Shown, never counted.
export function pendingAdjustmentSummary(adjustments, activeApprovalId) {
  const drafts = draftAdjustmentsFor(adjustments, activeApprovalId)
  const nets = drafts.map(adjustmentNet).filter(n => n !== null)
  return { count: drafts.length, net: roundMoney(nets.reduce((s, n) => s + n, 0)) }
}
