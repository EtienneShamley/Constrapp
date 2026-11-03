import { roundMoney } from './purchaseOrders'
import { firestoreValueBytes } from './ganttBaseline'

// ── Approved Budget Versions — Constrapp SHIELD™ 2B1 (ADR-70) ────────────────
//
// Pure domain logic for the formal approval of a project's budget. No
// Firestore, no React.
//
// THE MODEL (three documents, mirroring the ADR-66 programme baseline):
//
//   budgetApprovals/{approvalId}          the HEADER — reason, lifecycle
//                                         (draft → approved | withdrawn, both
//                                         terminal), currency, entryCount,
//                                         total (a CROSS-CHECK), version,
//                                         stamps
//   budgetApprovalSnapshots/{approvalId}  ONE immutable snapshot — every
//                                         working budget LINE as captured
//                                         (lineId, costCodeId, costCodeName,
//                                         budgeted), created with its header
//                                         in the same commit, never updated
//   approvedBudget/current                ONE pointer — the ACTIVE version
//                                         (activeApprovalId, versionCount),
//                                         the ORIGINAL version
//                                         (originalApprovalId — version 1),
//                                         advanced only by an approval
//
// ⚠️ THE APPROVED BUDGET IS DERIVED BY SUMMING THE ACTIVE SNAPSHOT'S ENTRIES.
// The header `total` and the snapshot `total` are cross-checks that the
// read-time validation compares; neither is ever the figure shown. A snapshot
// whose entries do not sum to its header, a pointer naming a header that is
// not approved, a header whose version is not the pointer's count, or a
// currency that is not the project's makes the approved budget UNAVAILABLE —
// never a fallback to the editable working lines, never a zero (ADR-70).
//
// WORKING vs APPROVED. `budgetLines` stay the editable preparation register.
// Once a version is approved, every financial consumer reads the snapshot
// through `resolveBudgetSource` / `budgetLinesFor` (one adapter, one source of
// truth); until then the working lines are shown, labelled "Working budget
// (not approved)" — never relabelled as approved.
//
// Version 1 is the ORIGINAL approved budget; the active version is the
// CURRENT approved budget. Approved versions are never edited, withdrawn or
// deleted; a re-approval creates a new version and leaves every earlier one
// exactly as approved.
//
// What rules cannot prove (SECURITY.md → Deferred Control 44): every entry
// between the two pinned ends, completeness of the capture against the live
// register, the drift the approver reviewed, self-approval (permitted).

export const BUDGET_APPROVAL_STATUS = {
  DRAFT:     'draft',
  APPROVED:  'approved',
  WITHDRAWN: 'withdrawn',
}

export const BUDGET_APPROVAL_STATUS_ORDER = [
  BUDGET_APPROVAL_STATUS.DRAFT, BUDGET_APPROVAL_STATUS.APPROVED, BUDGET_APPROVAL_STATUS.WITHDRAWN,
]

export const BUDGET_APPROVAL_STATUS_LABELS = {
  [BUDGET_APPROVAL_STATUS.DRAFT]:     'Draft',
  [BUDGET_APPROVAL_STATUS.APPROVED]:  'Approved',
  [BUDGET_APPROVAL_STATUS.WITHDRAWN]: 'Withdrawn',
}

// Reuses the existing semantic Badge variants (DESIGN_SYSTEM.md): draft→soon,
// approved→active, withdrawn→danger.
export const BUDGET_APPROVAL_STATUS_BADGE = {
  [BUDGET_APPROVAL_STATUS.DRAFT]:     'soon',
  [BUDGET_APPROVAL_STATUS.APPROVED]:  'active',
  [BUDGET_APPROVAL_STATUS.WITHDRAWN]: 'danger',
}

export const isBudgetApprovalStatus = (s) => BUDGET_APPROVAL_STATUS_ORDER.includes(s)

// draft → approved, draft → withdrawn. Both are TERMINAL.
export function canBudgetApprovalTransition(from, to) {
  if (from !== BUDGET_APPROVAL_STATUS.DRAFT) return false
  return to === BUDGET_APPROVAL_STATUS.APPROVED || to === BUDGET_APPROVAL_STATUS.WITHDRAWN
}

export const BUDGET_APPROVAL_LIMITS = {
  reason: 500,
  withdrawReason: 500,
  // Entries per snapshot (rules-pinned). The byte ceiling below also applies;
  // the smaller wins.
  entries: 2000,
  costCodeName: 170,
}

// Firestore refuses a document above 1 MiB; the capture is refused well below
// that (the ADR-66 margin). A worst-case 2,000-entry budget snapshot with
// 170-character names is about 500 KB.
export const BUDGET_SNAPSHOT_MAX_BYTES = 900_000

export const BUDGET_ENTRY_KEYS = ['lineId', 'costCodeId', 'costCodeName', 'budgeted']

export const BUDGET_HEADER_KEYS = [
  'reason', 'status', 'currency', 'entryCount', 'total', 'version',
  'approvedAt', 'approvedBy', 'withdrawnAt', 'withdrawnBy', 'withdrawReason',
  'revision', 'createdAt', 'createdBy', 'updatedAt', 'updatedBy',
]

export const BUDGET_POINTER_KEYS = [
  'activeApprovalId', 'originalApprovalId', 'versionCount',
  'approvedAt', 'approvedBy', 'createdAt', 'createdBy', 'updatedAt', 'updatedBy',
]

// ── Roles (UX mirrors — Firestore rules are the enforced boundary) ───────────

// Any internal financial role may PREPARE (capture) a draft — the Budget tab's
// writer set, so the QS who maintains the budget can prepare its approval.
export const BUDGET_PREPARE_ROLES = ['company_admin', 'project_manager', 'qs']
// Only company_admin / project_manager may APPROVE (rules-enforced); qs cannot.
export const BUDGET_APPROVE_ROLES = ['company_admin', 'project_manager']

export const canPrepareBudgetApproval = (role) => BUDGET_PREPARE_ROLES.includes(role)
export const canApproveBudget = (role) => BUDGET_APPROVE_ROLES.includes(role)
// A draft may be withdrawn by an approver, or by the person who captured it.
export const canWithdrawBudgetDraft = (role, header, uid) =>
  canApproveBudget(role) || (canPrepareBudgetApproval(role) && Boolean(uid) && header?.createdBy === uid)

// ── Draft inputs ─────────────────────────────────────────────────────────────

const trimTo = (v, max) => String(v ?? '').trim().slice(0, max)

export function validateBudgetApprovalDraft({ reason } = {}) {
  const r = String(reason ?? '').trim()
  if (!r) return 'Enter the reason for this budget approval'
  if (r.length > BUDGET_APPROVAL_LIMITS.reason) return `The reason must be ${BUDGET_APPROVAL_LIMITS.reason} characters or fewer`
  return null
}

export function normaliseBudgetApprovalDraft({ reason } = {}) {
  return { reason: trimTo(reason, BUDGET_APPROVAL_LIMITS.reason) }
}

export function validateBudgetWithdrawReason(reason) {
  const r = String(reason ?? '').trim()
  if (!r) return 'Enter a reason for withdrawing this draft'
  if (r.length > BUDGET_APPROVAL_LIMITS.withdrawReason) {
    return `The reason must be ${BUDGET_APPROVAL_LIMITS.withdrawReason} characters or fewer`
  }
  return null
}

// ── Capture projection ───────────────────────────────────────────────────────
//
// ONE entry per working budget line — the line's identity, its cost-code
// spine, the frozen name and the amount. Lines are the stored source
// documents, so the two end entries can be pinned by rules to real records
// (`get()` on the line), several legitimate lines on one cost code are
// preserved as separate entries, and the per-cost-code figure every consumer
// needs is a trivial read-time fold. Nothing is repaired: an invalid line
// refuses the capture by name.

const isMoney = (v) => typeof v === 'number' && Number.isFinite(v)

export function projectBudgetEntry(line) {
  const l = line ?? {}
  return {
    lineId:       typeof l.id === 'string' ? l.id : '',
    costCodeId:   typeof l.costCodeId === 'string' ? l.costCodeId : '',
    costCodeName: typeof l.costCodeName === 'string' ? l.costCodeName : '',
    budgeted:     isMoney(l.budgeted) ? roundMoney(l.budgeted) : l.budgeted,
  }
}

// Returns null when valid, otherwise the reason. `costCodeById` is the
// company cost-code library (a Map or object); a line whose cost code is not
// in it is refused — an inactive code is permitted (the line legitimately
// keeps it) and counted separately.
export function validateBudgetEntry(entry, costCodeById = null) {
  const e = entry ?? {}
  if (!e.lineId) return 'has no usable line identity'
  if (!e.costCodeId) return 'has no cost code'
  if (typeof e.costCodeName !== 'string') return 'has a malformed cost-code name'
  if (e.costCodeName.length > BUDGET_APPROVAL_LIMITS.costCodeName) return 'has a cost-code name that is too long'
  if (!isMoney(e.budgeted)) return 'has a budgeted amount that is not a number'
  if (e.budgeted < 0) return 'has a negative budgeted amount'
  if (roundMoney(e.budgeted) !== e.budgeted) return 'has a budgeted amount with more than two decimal places'
  if (costCodeById) {
    const cc = costCodeById instanceof Map ? costCodeById.get(e.costCodeId) : costCodeById[e.costCodeId]
    if (!cc) return 'names a cost code that does not exist'
  }
  return null
}

export function estimateBudgetSnapshotBytes(entries, { capturedBy = '', currency = 'AUD', pathBytes = 200 } = {}) {
  const doc = {
    entryCount: (entries ?? []).length,
    total: 0,
    currency,
    capturedAt: 0,
    capturedBy,
    entries: entries ?? [],
  }
  return firestoreValueBytes(doc) + pathBytes + 32
}

// Deterministic capture order: cost-code name, then line id — so two captures
// of the same register are byte-identical.
const compareEntries = (a, b) =>
  String(a.costCodeName).localeCompare(String(b.costCodeName)) || String(a.lineId).localeCompare(String(b.lineId))

const sumEntries = (entries) => roundMoney((entries ?? []).reduce((s, e) => s + (Number(e?.budgeted) || 0), 0))

// Builds EXACTLY what the snapshot document will hold, from the budget lines
// and cost codes the caller read — the action layer passes a FRESH SERVER
// read of both, never the listener. Every line is projected; a line that
// fails validation, or a duplicate line id, REFUSES the whole capture with
// the records named. Never a partial list.
export function buildBudgetCapturePayload(budgetLines, costCodes, { capturedBy = '', currency = 'AUD' } = {}) {
  const codeMap = new Map((costCodes ?? []).filter(c => c?.id).map(c => [c.id, c]))
  const projected = (budgetLines ?? []).map(projectBudgetEntry).sort(compareEntries)
  const entries = []
  const errors = []
  const seen = new Set()
  let inactive = 0
  const costCodeIds = new Set()

  for (const entry of projected) {
    const label = entry.costCodeName || entry.lineId || 'A budget line'
    const problem = validateBudgetEntry(entry, codeMap)
    if (problem) { errors.push({ lineId: entry.lineId, name: label, reason: `${label} ${problem}` }); continue }
    if (seen.has(entry.lineId)) {
      errors.push({ lineId: entry.lineId, name: label, reason: `${label} appears twice in the budget read` })
      continue
    }
    seen.add(entry.lineId)
    if (codeMap.get(entry.costCodeId)?.isActive === false) inactive += 1
    costCodeIds.add(entry.costCodeId)
    entries.push(entry)
  }

  const total = sumEntries(entries)
  const bytes = estimateBudgetSnapshotBytes(entries, { capturedBy, currency })
  const counts = {
    total: projected.length,
    captured: entries.length,
    invalid: errors.length,
    inactive,
    costCodes: costCodeIds.size,
  }

  let refusal = null
  if (errors.length > 0) {
    refusal = `${errors.length} budget ${errors.length === 1 ? 'line cannot' : 'lines cannot'} be captured as stored. Correct ${errors.length === 1 ? 'it' : 'them'} on the Budget tab and try again — nothing is excluded silently.`
  } else if (entries.length === 0) {
    refusal = 'There are no budget lines to approve.'
  } else if (entries.length > BUDGET_APPROVAL_LIMITS.entries) {
    refusal = `A budget approval may hold at most ${BUDGET_APPROVAL_LIMITS.entries} budget lines; this project has ${entries.length}. Nothing was written.`
  } else if (bytes > BUDGET_SNAPSHOT_MAX_BYTES) {
    refusal = `This budget snapshot would be about ${Math.round(bytes / 1024)} KB, above the ${Math.round(BUDGET_SNAPSHOT_MAX_BYTES / 1024)} KB a single approval may hold. Nothing was written and nothing was truncated.`
  }

  return { ok: refusal === null, entries, errors, counts, total, currency, bytes, byteCeiling: BUDGET_SNAPSHOT_MAX_BYTES, refusal }
}

// ── Snapshot reading ─────────────────────────────────────────────────────────

export const isBudgetSnapshotUsable = (snapshot) =>
  Boolean(snapshot) && Array.isArray(snapshot.entries) && Number.isInteger(snapshot.entryCount)

// entries indexed by line id (the first occurrence wins; duplicates are an
// integrity problem the validation reports).
export function budgetSnapshotIndex(snapshot) {
  const map = new Map()
  for (const e of snapshot?.entries ?? []) {
    if (e?.lineId && !map.has(e.lineId)) map.set(e.lineId, e)
  }
  return map
}

// The snapshot's entries in the budget-line shape every existing selector
// consumes ({ id, costCodeId, costCodeName, budgeted }) — the ONE bridge from
// the immutable snapshot into buildForecastRows / boqVsBudgetRows /
// approvedBudgetForPackage, so no selector learns a second budget schema.
export function snapshotAsBudgetLines(snapshot) {
  return (snapshot?.entries ?? []).map(e => ({
    id: e.lineId, costCodeId: e.costCodeId, costCodeName: e.costCodeName, budgeted: e.budgeted, fromApprovedSnapshot: true,
  }))
}

export const approvedTotalOf = (snapshot) => sumEntries(snapshot?.entries)

// Per-cost-code approved amounts (the read-time fold).
export function approvedByCostCode(snapshot) {
  const map = {}
  for (const e of snapshot?.entries ?? []) {
    if (!e?.costCodeId) continue
    map[e.costCodeId] = roundMoney((map[e.costCodeId] || 0) + (Number(e.budgeted) || 0))
  }
  return map
}

// ── Integrity validation (read-time; fail closed) ────────────────────────────

export const BUDGET_INTEGRITY_PROBLEM = {
  POINTER_MALFORMED:    'pointer_malformed',
  HEADER_MISSING:       'header_missing',
  HEADER_NOT_APPROVED:  'header_not_approved',
  HEADER_IDENTITY:      'header_identity',
  HEADER_VERSION:       'header_version',
  SNAPSHOT_MISSING:     'snapshot_missing',
  SNAPSHOT_SHAPE:       'snapshot_shape',
  SNAPSHOT_COUNT:       'snapshot_count',
  ENTRY_MALFORMED:      'entry_malformed',
  ENTRY_DUPLICATE:      'entry_duplicate',
  TOTAL_MISMATCH:       'total_mismatch',
  CURRENCY_MISMATCH:    'currency_mismatch',
  ORIGINAL_MISSING:     'original_missing',
  ORIGINAL_SHAPE:       'original_shape',
}

export const BUDGET_INTEGRITY_PROBLEM_TEXT = {
  [BUDGET_INTEGRITY_PROBLEM.POINTER_MALFORMED]:   'The approved-budget pointer is malformed.',
  [BUDGET_INTEGRITY_PROBLEM.HEADER_MISSING]:      'The active approval header is missing.',
  [BUDGET_INTEGRITY_PROBLEM.HEADER_NOT_APPROVED]: 'The active approval header is not in the approved state.',
  [BUDGET_INTEGRITY_PROBLEM.HEADER_IDENTITY]:     'The active approval header is not the one the pointer names.',
  [BUDGET_INTEGRITY_PROBLEM.HEADER_VERSION]:      'The active approval version does not match the pointer\'s version count.',
  [BUDGET_INTEGRITY_PROBLEM.SNAPSHOT_MISSING]:    'The approved budget snapshot is missing.',
  [BUDGET_INTEGRITY_PROBLEM.SNAPSHOT_SHAPE]:      'The approved budget snapshot is malformed.',
  [BUDGET_INTEGRITY_PROBLEM.SNAPSHOT_COUNT]:      'The snapshot entry count does not match its entries or its header.',
  [BUDGET_INTEGRITY_PROBLEM.ENTRY_MALFORMED]:     'A snapshot entry is malformed.',
  [BUDGET_INTEGRITY_PROBLEM.ENTRY_DUPLICATE]:     'A snapshot entry repeats a budget line.',
  [BUDGET_INTEGRITY_PROBLEM.TOTAL_MISMATCH]:      'The snapshot entries do not sum to the recorded total.',
  [BUDGET_INTEGRITY_PROBLEM.CURRENCY_MISMATCH]:   'The approved budget currency is not the project currency.',
  [BUDGET_INTEGRITY_PROBLEM.ORIGINAL_MISSING]:    'The original (version 1) snapshot is missing.',
  [BUDGET_INTEGRITY_PROBLEM.ORIGINAL_SHAPE]:      'The original (version 1) snapshot is malformed.',
}

const toCents = (n) => Math.round((Number(n) || 0) * 100)

// Problems with one snapshot against its header (or standalone when `header`
// is null). Every entry is checked — this is the client-side completeness the
// rules cannot provide for the middle entries.
export function validateBudgetSnapshot(snapshot, header = null, { currencyCode = null } = {}) {
  const problems = []
  if (!snapshot) return [BUDGET_INTEGRITY_PROBLEM.SNAPSHOT_MISSING]
  if (!isBudgetSnapshotUsable(snapshot)) return [BUDGET_INTEGRITY_PROBLEM.SNAPSHOT_SHAPE]
  const entries = snapshot.entries
  if (entries.length === 0 || entries.length !== snapshot.entryCount) problems.push(BUDGET_INTEGRITY_PROBLEM.SNAPSHOT_COUNT)
  if (header && header.entryCount !== snapshot.entryCount) problems.push(BUDGET_INTEGRITY_PROBLEM.SNAPSHOT_COUNT)
  const seen = new Set()
  let malformed = false
  let duplicate = false
  for (const e of entries) {
    if (validateBudgetEntry(e) !== null) { malformed = true; continue }
    if (seen.has(e.lineId)) duplicate = true
    seen.add(e.lineId)
  }
  if (malformed) problems.push(BUDGET_INTEGRITY_PROBLEM.ENTRY_MALFORMED)
  if (duplicate) problems.push(BUDGET_INTEGRITY_PROBLEM.ENTRY_DUPLICATE)
  if (!malformed) {
    const sum = toCents(approvedTotalOf(snapshot))
    if (!isMoney(snapshot.total) || toCents(snapshot.total) !== sum) problems.push(BUDGET_INTEGRITY_PROBLEM.TOTAL_MISMATCH)
    else if (header && (!isMoney(header.total) || toCents(header.total) !== sum)) problems.push(BUDGET_INTEGRITY_PROBLEM.TOTAL_MISMATCH)
  }
  const currencies = [snapshot.currency, header?.currency, currencyCode].filter(c => c !== null && c !== undefined)
  if (currencies.some(c => typeof c !== 'string' || c !== currencies[0])) problems.push(BUDGET_INTEGRITY_PROBLEM.CURRENCY_MISMATCH)
  return [...new Set(problems)]
}

// ── The source of truth adapter ──────────────────────────────────────────────

export const BUDGET_SOURCE = {
  LOADING:     'loading',     // a read has not settled
  UNAVAILABLE: 'unavailable', // a read failed, or the approved records are inconsistent
  APPROVED:    'approved',    // an active approved version: the snapshot is the figure
  WORKING:     'working',     // no approved version yet: the editable lines, labelled unapproved
}

export const BUDGET_SOURCE_LABELS = {
  [BUDGET_SOURCE.LOADING]:     'Loading',
  [BUDGET_SOURCE.UNAVAILABLE]: 'Unavailable',
  [BUDGET_SOURCE.APPROVED]:    'Approved Budget',
  [BUDGET_SOURCE.WORKING]:     'Working budget (not approved)',
}

const flag = (v) => v === true

// `approvedBudget` is the composite hook's object:
//   { pointer, pointerLoading, pointerError,
//     header, headerLoading, headerError,
//     snapshot, snapshotLoading, snapshotError,
//     originalSnapshot, originalLoading, originalError, originalRequested }
// or undefined / null (no subscription — treated as "no pointer", i.e. the
// working budget, so a caller that has not adopted 2B1 reads exactly as before).
// `budgetLines` (with their loading / error flags) are the working register.
//
// Returns the resolved source. In WORKING mode the budget-lines read state is
// folded in, so one `sourceStates.approvedBudget` entry is the truth for every
// budget figure whichever source is live.
export function resolveBudgetSource({
  approvedBudget = null,
  budgetLines = [],
  budgetLinesLoading = false,
  budgetLinesError = false,
  currencyCode = null,
} = {}) {
  const ab = approvedBudget && typeof approvedBudget === 'object' && !Array.isArray(approvedBudget) ? approvedBudget : {}
  const base = {
    pointer: ab.pointer ?? null, header: ab.header ?? null, snapshot: ab.snapshot ?? null,
    originalSnapshot: ab.originalSnapshot ?? null,
    version: null, versionCount: 0, approvedAt: null, approvedBy: null, reason: '',
    total: null, originalTotal: null, lines: [], problems: [],
  }

  if (flag(ab.pointerLoading)) return { ...base, kind: BUDGET_SOURCE.LOADING }
  if (flag(ab.pointerError)) return { ...base, kind: BUDGET_SOURCE.UNAVAILABLE }

  const pointer = ab.pointer ?? null
  if (!pointer) {
    // No approved version: the working register, with its own read state.
    if (budgetLinesLoading) return { ...base, kind: BUDGET_SOURCE.LOADING }
    if (budgetLinesError) return { ...base, kind: BUDGET_SOURCE.UNAVAILABLE }
    const lines = Array.isArray(budgetLines) ? budgetLines : []
    return { ...base, kind: BUDGET_SOURCE.WORKING, lines, total: sumEntries(lines) }
  }

  const problems = []
  if (typeof pointer.activeApprovalId !== 'string' || !pointer.activeApprovalId
    || !Number.isInteger(pointer.versionCount) || pointer.versionCount < 1
    || typeof pointer.originalApprovalId !== 'string' || !pointer.originalApprovalId) {
    return { ...base, kind: BUDGET_SOURCE.UNAVAILABLE, problems: [BUDGET_INTEGRITY_PROBLEM.POINTER_MALFORMED] }
  }

  if (flag(ab.headerLoading) || flag(ab.snapshotLoading)) return { ...base, kind: BUDGET_SOURCE.LOADING }
  if (flag(ab.headerError)) return { ...base, kind: BUDGET_SOURCE.UNAVAILABLE, problems: [BUDGET_INTEGRITY_PROBLEM.HEADER_MISSING] }
  if (flag(ab.snapshotError)) return { ...base, kind: BUDGET_SOURCE.UNAVAILABLE, problems: [BUDGET_INTEGRITY_PROBLEM.SNAPSHOT_MISSING] }

  const header = ab.header ?? null
  const snapshot = ab.snapshot ?? null
  if (!header) problems.push(BUDGET_INTEGRITY_PROBLEM.HEADER_MISSING)
  else {
    if (header.id && header.id !== pointer.activeApprovalId) problems.push(BUDGET_INTEGRITY_PROBLEM.HEADER_IDENTITY)
    if (header.status !== BUDGET_APPROVAL_STATUS.APPROVED) problems.push(BUDGET_INTEGRITY_PROBLEM.HEADER_NOT_APPROVED)
    if (header.version !== pointer.versionCount) problems.push(BUDGET_INTEGRITY_PROBLEM.HEADER_VERSION)
  }
  problems.push(...validateBudgetSnapshot(snapshot, header, { currencyCode }))

  // The original (version 1) is read only when a consumer needs it (margin:
  // Original Planned Profit, Margin Movement). When the active version IS
  // version 1 the active snapshot is the original.
  let originalTotal = null
  if (ab.originalRequested) {
    if (pointer.originalApprovalId === pointer.activeApprovalId) {
      originalTotal = problems.length === 0 ? approvedTotalOf(snapshot) : null
    } else if (flag(ab.originalLoading)) {
      return { ...base, kind: BUDGET_SOURCE.LOADING }
    } else if (flag(ab.originalError) || !ab.originalSnapshot) {
      problems.push(BUDGET_INTEGRITY_PROBLEM.ORIGINAL_MISSING)
    } else {
      const op = validateBudgetSnapshot(ab.originalSnapshot, null, { currencyCode })
      if (op.length > 0) problems.push(BUDGET_INTEGRITY_PROBLEM.ORIGINAL_SHAPE)
      else originalTotal = approvedTotalOf(ab.originalSnapshot)
    }
  }

  const unique = [...new Set(problems)]
  if (unique.length > 0) return { ...base, kind: BUDGET_SOURCE.UNAVAILABLE, problems: unique }

  return {
    ...base,
    kind: BUDGET_SOURCE.APPROVED,
    version: header.version,
    versionCount: pointer.versionCount,
    approvedAt: header.approvedAt ?? null,
    approvedBy: header.approvedBy ?? null,
    reason: header.reason ?? '',
    total: approvedTotalOf(snapshot),
    originalTotal,
    lines: snapshotAsBudgetLines(snapshot),
  }
}

// The { loading, error } entry for `sourceStates.approvedBudget` — the
// Dashboard snapshot's shape, so figureState gates every budget figure.
export function budgetSourceState(resolved) {
  const kind = resolved?.kind
  return {
    loading: kind === BUDGET_SOURCE.LOADING,
    error: kind === BUDGET_SOURCE.UNAVAILABLE || !kind,
  }
}

// The budget-line-shaped rows every selector consumes, from the resolved
// source: the snapshot's entries when approved, the working lines until then,
// and NOTHING while loading / unavailable (the figure is gated anyway).
export function budgetLinesFor(resolved) {
  if (!resolved) return []
  if (resolved.kind === BUDGET_SOURCE.APPROVED || resolved.kind === BUDGET_SOURCE.WORKING) return resolved.lines ?? []
  return []
}

export const isApprovedSource = (resolved) => resolved?.kind === BUDGET_SOURCE.APPROVED
export const isWorkingSource  = (resolved) => resolved?.kind === BUDGET_SOURCE.WORKING

// The Original Approved Budget figure margin should use: version 1's total
// when an approved source carries it, otherwise the legacy commercial-baseline
// scalar (ADR-20) — `undefined` means "use the baseline's", so computeMargin
// behaves exactly as before for a caller without 2B1 data.
export function originalApprovedBudgetFor(resolved) {
  if (resolved?.kind === BUDGET_SOURCE.APPROVED && isMoney(resolved.originalTotal)) return resolved.originalTotal
  return undefined
}

// ── Drift: the working register versus a captured snapshot ───────────────────
//
// What changed since the capture — shown to the approver, who must review it
// explicitly. Read-time only; the approve action re-reads the server and
// refuses when the drift it finds is not the drift the approver acknowledged.

export function budgetDrift(budgetLines, snapshot) {
  const byEntry = budgetSnapshotIndex(snapshot)
  const live = new Map()
  for (const l of budgetLines ?? []) if (l?.id) live.set(l.id, l)

  const changed = []
  const added = []
  const missing = []
  for (const l of live.values()) {
    const e = byEntry.get(l.id)
    if (!e) { added.push({ lineId: l.id, costCodeName: l.costCodeName ?? '', amount: isMoney(l.budgeted) ? l.budgeted : null }); continue }
    const current = isMoney(l.budgeted) ? roundMoney(l.budgeted) : null
    if (current === null || toCents(current) !== toCents(e.budgeted) || l.costCodeId !== e.costCodeId) {
      changed.push({ lineId: l.id, costCodeName: e.costCodeName ?? l.costCodeName ?? '', from: e.budgeted, to: current })
    }
  }
  for (const e of byEntry.values()) {
    if (!live.has(e.lineId)) missing.push({ lineId: e.lineId, costCodeName: e.costCodeName ?? '', amount: e.budgeted })
  }
  const byName = (x, y) => String(x.costCodeName).localeCompare(String(y.costCodeName)) || String(x.lineId).localeCompare(String(y.lineId))
  for (const l of [changed, added, missing]) l.sort(byName)
  const total = changed.length + added.length + missing.length
  return { changed, added, missing, total, any: total > 0, key: budgetDriftKey({ changed, added, missing }) }
}

// A stable key for the approver's acknowledgement: names every drifted line
// and its current amount, so the acknowledgement is of THIS drift and no other.
export function budgetDriftKey({ changed = [], added = [], missing = [] } = {}) {
  const part = (tag, list, withAmount) => list
    .map(x => `${x.lineId}${withAmount ? `@${x.to ?? x.amount ?? 'x'}` : ''}`)
    .sort()
    .map(s => `${tag}:${s}`)
  return [...part('c', changed, true), ...part('a', added, true), ...part('m', missing, false)].join('|')
}

// ── Versions: history, active, original ──────────────────────────────────────

const tsMillis = (t) => {
  if (!t) return null
  if (typeof t.toMillis === 'function') return t.toMillis()
  if (typeof t.seconds === 'number') return t.seconds * 1000 + Math.floor((t.nanoseconds ?? 0) / 1e6)
  if (typeof t === 'number') return t
  return null
}

export const isApprovedBudgetVersion = (h) =>
  h?.status === BUDGET_APPROVAL_STATUS.APPROVED && Number.isInteger(h.version) && h.version >= 1

// Approved headers in version order (1 first).
export function approvedBudgetVersions(headers) {
  return (headers ?? []).filter(isApprovedBudgetVersion).sort((a, b) => a.version - b.version || (tsMillis(a.approvedAt) ?? 0) - (tsMillis(b.approvedAt) ?? 0))
}

export const draftBudgetApprovals = (headers) =>
  (headers ?? []).filter(h => h?.status === BUDGET_APPROVAL_STATUS.DRAFT)
    .sort((a, b) => (tsMillis(a.createdAt) ?? 0) - (tsMillis(b.createdAt) ?? 0))

// History order for the panel: approved versions descending, then drafts,
// then withdrawn — newest first within each group.
export function budgetApprovalHistory(headers) {
  const rank = { [BUDGET_APPROVAL_STATUS.APPROVED]: 0, [BUDGET_APPROVAL_STATUS.DRAFT]: 1, [BUDGET_APPROVAL_STATUS.WITHDRAWN]: 2 }
  return [...(headers ?? [])].sort((a, b) => {
    const r = (rank[a?.status] ?? 3) - (rank[b?.status] ?? 3)
    if (r !== 0) return r
    if (a?.status === BUDGET_APPROVAL_STATUS.APPROVED) return (b.version ?? 0) - (a.version ?? 0)
    return (tsMillis(b?.createdAt) ?? 0) - (tsMillis(a?.createdAt) ?? 0)
  })
}

export function budgetVersionLabel(header) {
  if (!header) return ''
  if (isApprovedBudgetVersion(header)) return header.version === 1 ? 'Version 1 · Original' : `Version ${header.version}`
  return header.status === BUDGET_APPROVAL_STATUS.DRAFT ? 'Draft' : 'Withdrawn draft'
}

// ── Pending difference: working register vs the approved figure ──────────────

// Per cost code: approved amount, working amount, difference. For the Budget
// tab's "approved vs working" column and the pending-change summary.
export function workingVsApproved(budgetLines, resolved) {
  const approved = resolved?.kind === BUDGET_SOURCE.APPROVED
  const approvedByLine = approved ? budgetSnapshotIndex(resolved.snapshot) : new Map()
  const rows = []
  let workingTotal = 0
  let approvedTotal = 0
  for (const l of budgetLines ?? []) {
    const working = isMoney(l?.budgeted) ? roundMoney(l.budgeted) : 0
    const e = approvedByLine.get(l?.id)
    const approvedAmount = e ? roundMoney(Number(e.budgeted) || 0) : null
    workingTotal = roundMoney(workingTotal + working)
    if (approvedAmount !== null) approvedTotal = roundMoney(approvedTotal + approvedAmount)
    rows.push({ lineId: l?.id, working, approved: approvedAmount, difference: approvedAmount === null ? null : roundMoney(working - approvedAmount) })
  }
  // Lines in the snapshot that no longer appear in the register are still part
  // of the approved figure.
  for (const e of approvedByLine.values()) {
    if (!(budgetLines ?? []).some(l => l?.id === e.lineId)) approvedTotal = roundMoney(approvedTotal + (Number(e.budgeted) || 0))
  }
  const changedCount = rows.filter(r => r.difference !== null && r.difference !== 0).length
  const addedCount = approved ? rows.filter(r => r.approved === null).length : 0
  return {
    rows, workingTotal,
    approvedTotal: approved ? resolved.total : null,
    difference: approved ? roundMoney(workingTotal - resolved.total) : null,
    changedCount, addedCount,
    pending: approved && (changedCount > 0 || addedCount > 0 || toCents(workingTotal) !== toCents(resolved.total)),
  }
}

// The difference between two snapshots by cost code (the review dialog's
// "against the previous approved version").
export function snapshotDelta(nextSnapshot, previousSnapshot) {
  const next = approvedByCostCode(nextSnapshot)
  const prev = approvedByCostCode(previousSnapshot)
  const names = {}
  for (const e of [...(previousSnapshot?.entries ?? []), ...(nextSnapshot?.entries ?? [])]) if (e?.costCodeId && e.costCodeName) names[e.costCodeId] = e.costCodeName
  const ids = new Set([...Object.keys(next), ...Object.keys(prev)])
  const rows = []
  for (const id of ids) {
    const a = prev[id] ?? null
    const b = next[id] ?? null
    rows.push({ costCodeId: id, costCodeName: names[id] ?? id, previous: a, next: b, difference: roundMoney((b ?? 0) - (a ?? 0)) })
  }
  rows.sort((x, y) => String(x.costCodeName).localeCompare(String(y.costCodeName)))
  return {
    rows: rows.filter(r => r.difference !== 0 || r.previous === null || r.next === null),
    previousTotal: previousSnapshot ? approvedTotalOf(previousSnapshot) : null,
    nextTotal: approvedTotalOf(nextSnapshot),
    difference: previousSnapshot ? roundMoney(approvedTotalOf(nextSnapshot) - approvedTotalOf(previousSnapshot)) : null,
  }
}
