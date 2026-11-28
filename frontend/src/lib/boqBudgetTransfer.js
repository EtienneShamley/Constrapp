import { BOQ_STATUS, isPriced, boqLineAmount } from './boq'
import { toCents } from './payments'
import { isActiveCostCode, costCodeDisplayName } from './costCodes'

// ── BOQ → working budget transfer — L4 (ADR-81) ──────────────────────────────
//
// Pure: no React, no Firebase, no clock. This module is the ONE description of
// how a priced Bill of Quantities becomes WORKING budget lines. It runs in two
// places from the same source:
//
//   · the browser, to show the reviewer the proposal;
//   · the trusted `transferBoqToBudget` callable, through the generated bundle
//     `functions/src/generated/boqBudgetTransferCalc.js`, which recomputes the
//     proposal from records it reads itself and writes nothing a reviewer did
//     not see.
//
// WHAT IT PRODUCES. One ROW per cost code that has active BOQ items or already
// holds a BOQ-sourced budget line. A row is exactly one of:
//
//   create          no budget line on the code → a new BOQ-sourced line
//   refresh         a BOQ-sourced line whose amount is not the BOQ amount
//   unchanged       a BOQ-sourced line that already equals the BOQ amount
//   zero-available  a BOQ-sourced line whose BOQ items are now all void; it is
//                   left alone unless the reviewer explicitly ticks set-to-zero
//   blocked         the code cannot be transferred, with every reason listed
//
// ⚠️ NO NEW FINANCIAL FORMULA. An item's amount is the stored, rules-pinned
// `amount` (lib/boq.js → boqLineAmount); this module only re-checks it against
// that same function and adds whole cents. Nothing here reads or writes an
// approved budget version: the transfer touches WORKING lines only, and a
// working line becomes approved solely through the existing SHIELD capture
// and approval (ADR-70 / ADR-71).
//
// ⚠️ A FINGERPRINT IS NOT A BOQ REVISION. `sourceFingerprint` answers one
// question — "are the active BOQ items on this cost code the ones that were
// transferred?" — and cannot reconstruct them. BOQ items stay editable and
// keep no history.

export const BOQ_TRANSFER_VERSION = 'v1'

// The roles that may transfer: the Budget tab's authoring set. The callable
// enforces it from the caller's membership; this copy is the UI mirror.
export const BOQ_TRANSFER_ROLES = ['company_admin', 'project_manager', 'qs']
export const canTransferBoqToBudget = (role) => BOQ_TRANSFER_ROLES.includes(role)

// ONE BOQ-sourced line per cost code, at a deterministic id. Firestore rules
// reserve the prefix (and the `boqSource` field) against every client create,
// so only the trusted callable can make one, and a second line for the same
// cost code cannot exist.
export const BOQ_LINE_ID_PREFIX = 'boq-'
export const boqBudgetLineId = (costCodeId) => `${BOQ_LINE_ID_PREFIX}${costCodeId}`

export const TRANSFER_ROW_STATE = {
  CREATE:         'create',
  REFRESH:        'refresh',
  UNCHANGED:      'unchanged',
  ZERO_AVAILABLE: 'zero-available',
  BLOCKED:        'blocked',
}

export const TRANSFER_ROW_STATE_LABELS = {
  [TRANSFER_ROW_STATE.CREATE]:         'Create',
  [TRANSFER_ROW_STATE.REFRESH]:        'Refresh',
  [TRANSFER_ROW_STATE.UNCHANGED]:      'Unchanged',
  [TRANSFER_ROW_STATE.ZERO_AVAILABLE]: 'BOQ items void',
  [TRANSFER_ROW_STATE.BLOCKED]:        'Blocked',
}

export const TRANSFER_BLOCKER = {
  UNPRICED:           'unpriced',
  INVALID_SOURCE:     'invalid-source',
  CURRENCY_MISMATCH:  'currency-mismatch',
  COST_CODE_MISSING:  'cost-code-missing',
  COST_CODE_INACTIVE: 'cost-code-inactive',
  MANUAL_LINE:        'manual-line',
  MULTIPLE_LINES:     'multiple-lines',
  INVALID_LINE:       'invalid-line',
}

export const TRANSFER_BLOCKER_LABELS = {
  [TRANSFER_BLOCKER.UNPRICED]:           'One or more BOQ items on this cost code have no rate. Price every item (0 is a price) before transferring.',
  [TRANSFER_BLOCKER.INVALID_SOURCE]:     'A BOQ item on this cost code has a quantity or amount that cannot be used. Open and re-save the item.',
  [TRANSFER_BLOCKER.CURRENCY_MISMATCH]:  'A BOQ item on this cost code was priced in a different currency from the project.',
  [TRANSFER_BLOCKER.COST_CODE_MISSING]:  'This cost code no longer exists in the cost-code library.',
  [TRANSFER_BLOCKER.COST_CODE_INACTIVE]: 'This cost code is inactive.',
  [TRANSFER_BLOCKER.MANUAL_LINE]:        'A manually entered budget line already holds this cost code. Correct it on the Budget tab — the transfer never adds a second line.',
  [TRANSFER_BLOCKER.MULTIPLE_LINES]:     'More than one budget line shares this cost code. Resolve the manual line on the Budget tab before refreshing.',
  [TRANSFER_BLOCKER.INVALID_LINE]:       'The existing BOQ-sourced budget line cannot be read as an amount.',
}

// What the callable answers when it succeeds. A refusal is a typed error.
export const TRANSFER_OUTCOME = {
  APPLIED:         'applied',          // at least one working line was created or changed
  ALREADY_APPLIED: 'already-applied',  // this exact reviewed request was applied earlier and nothing has changed since
  UNCHANGED:       'unchanged',        // the review is current and there was nothing to write
}

// ── Digest ───────────────────────────────────────────────────────────────────
//
// Two 64-bit FNV-1a passes with different offset bases, as 32 hex characters
// (the lib/quantBoq.js idiom, doubled). NOT a cryptographic hash and not a
// secret: the server recomputes every key from its own reads, so a key only
// ever asserts "this is the state I reviewed".
function fnv1a64(str, basis) {
  let hash = basis
  const prime = 0x100000001b3n
  const mask = 0xffffffffffffffffn
  for (let i = 0; i < str.length; i++) {
    hash ^= BigInt(str.charCodeAt(i))
    hash = (hash * prime) & mask
  }
  return hash.toString(16).padStart(16, '0')
}
const digest = (str) => fnv1a64(str, 0xcbf29ce484222325n) + fnv1a64(str, 0x84222325cbf29ce4n)

const isNumber = (v) => typeof v === 'number' && Number.isFinite(v)
const num = (v) => (isNumber(v) ? String(v) : 'x')
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0)
export const centsToAmount = (cents) => cents / 100

// ── Source fingerprint (per cost code) ───────────────────────────────────────
//
// CANONICAL INPUTS, in this order, for every ACTIVE item on the cost code,
// sorted by item id:  id · quantity · rate ("null" when unpriced) · amount in
// whole cents ("null" when unpriced) · unit · currency.
// Numbers are serialised with String(). No timestamp, no actor, no label, no
// description, no array order: editing a description does not change it;
// editing a quantity, rate, unit or currency, adding an item, or voiding one
// does.
const itemKey = (item) => [
  item.id,
  num(item.quantity),
  isPriced(item.rate) ? num(item.rate) : 'null',
  isPriced(item.rate) ? (isNumber(item.amount) ? String(toCents(item.amount)) : 'x') : 'null',
  String(item.unit ?? ''),
  String(item.currency ?? ''),
].join(':')

export function sourceFingerprint(costCodeId, activeItems) {
  const rows = (activeItems ?? []).map(itemKey).sort(cmp)
  return `${BOQ_TRANSFER_VERSION}:${digest([costCodeId, String(rows.length), ...rows].join('|'))}`
}

// ── BOQ-sourced lines ────────────────────────────────────────────────────────

const isMap = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

// A budget line is BOQ-sourced when it sits at the reserved id for ITS cost
// code AND carries the server-written provenance map. Anything else on the
// cost code is a manual line.
export const isBoqSourcedLine = (line) =>
  Boolean(line?.id) && Boolean(line?.costCodeId) && line.id === boqBudgetLineId(line.costCodeId) && isMap(line.boqSource)

// What a budget line says about its BOQ origin, for display. `manuallyChanged`
// is true when the stored amount is no longer the amount of the latest
// transfer — the latest-transfer evidence then describes the TRANSFER, not the
// figure now on the line.
export function boqSourceInfo(line) {
  if (!isBoqSourcedLine(line)) return { isBoqSourced: false, first: null, latest: null, manuallyChanged: false }
  const first = isMap(line.boqSource.first) ? line.boqSource.first : null
  const latest = isMap(line.boqSource.latest) ? line.boqSource.latest : null
  const manuallyChanged = !latest || !isNumber(latest.amount) || !isNumber(line.budgeted)
    || toCents(latest.amount) !== toCents(line.budgeted)
  return { isBoqSourced: true, first, latest, manuallyChanged }
}

// ── The proposal ─────────────────────────────────────────────────────────────

const validQuantity = (q) => isNumber(q) && q >= 0

// A priced item is usable when its stored amount is exactly what lib/boq.js
// derives from its quantity and rate (the invariant Firestore rules pin on
// every BOQ write). Re-checked here so a malformed record blocks its cost code
// instead of entering a budget.
function pricedItemCents(item) {
  if (!validQuantity(item.quantity) || !isNumber(item.rate) || item.rate < 0) return null
  if (!isNumber(item.amount) || item.amount < 0) return null
  const derived = boqLineAmount(item.quantity, item.rate)
  if (derived === null || toCents(derived) !== toCents(item.amount)) return null
  return toCents(item.amount)
}

// `boqItems`, `budgetLines` and `costCodes` are whole registers ({ id, ...data }).
// `currencyCode` is the project's RESOLVED currency (lib/currency.js →
// resolveProjectCurrency).
export function buildTransferProposal({ boqItems = [], budgetLines = [], costCodes = [], currencyCode = null } = {}) {
  const codeById = new Map()
  for (const cc of costCodes ?? []) if (cc?.id) codeById.set(cc.id, cc)

  const itemsByCode = new Map()
  for (const item of boqItems ?? []) {
    if (!item?.id || item.status !== BOQ_STATUS.ACTIVE || !item.costCodeId) continue
    if (!itemsByCode.has(item.costCodeId)) itemsByCode.set(item.costCodeId, [])
    itemsByCode.get(item.costCodeId).push(item)
  }

  const linesByCode = new Map()
  for (const line of budgetLines ?? []) {
    if (!line?.id || !line.costCodeId) continue
    if (!linesByCode.has(line.costCodeId)) linesByCode.set(line.costCodeId, [])
    linesByCode.get(line.costCodeId).push(line)
  }

  // Row universe: every cost code with ACTIVE BOQ items, plus every cost code
  // that already holds a BOQ-sourced line (so a fully voided source is seen).
  const ids = new Set(itemsByCode.keys())
  for (const [costCodeId, lines] of linesByCode) if (lines.some(isBoqSourcedLine)) ids.add(costCodeId)

  const rows = []
  for (const costCodeId of ids) {
    const items = itemsByCode.get(costCodeId) ?? []
    const lines = linesByCode.get(costCodeId) ?? []
    const sourced = lines.find(isBoqSourcedLine) ?? null
    const manual = lines.filter(l => l !== sourced)
    const cc = codeById.get(costCodeId) ?? null
    const blockers = new Set()

    let boqCents = 0
    let unpricedCount = 0
    let invalid = false
    let mismatch = false
    for (const item of items) {
      if (!isPriced(item.rate)) { unpricedCount += 1; continue }
      const cents = pricedItemCents(item)
      if (cents === null) { invalid = true; continue }
      if (typeof currencyCode !== 'string' || item.currency !== currencyCode) mismatch = true
      boqCents += cents
    }
    if (unpricedCount > 0) blockers.add(TRANSFER_BLOCKER.UNPRICED)
    if (invalid) blockers.add(TRANSFER_BLOCKER.INVALID_SOURCE)
    if (mismatch) blockers.add(TRANSFER_BLOCKER.CURRENCY_MISMATCH)
    if (!cc) blockers.add(TRANSFER_BLOCKER.COST_CODE_MISSING)
    else if (!isActiveCostCode(cc)) blockers.add(TRANSFER_BLOCKER.COST_CODE_INACTIVE)
    if (manual.length > 0) blockers.add(sourced ? TRANSFER_BLOCKER.MULTIPLE_LINES : TRANSFER_BLOCKER.MANUAL_LINE)

    const sourcedValid = !sourced || (isNumber(sourced.budgeted) && sourced.budgeted >= 0)
    if (!sourcedValid) blockers.add(TRANSFER_BLOCKER.INVALID_LINE)
    const sourcedCents = sourced && sourcedValid ? toCents(sourced.budgeted) : null

    // Σ of every line on the code — what the working budget holds there now.
    // null (never 0) when there is no line, or when a line is unreadable.
    let workingCents = lines.length > 0 ? 0 : null
    for (const l of lines) {
      if (workingCents === null) break
      workingCents = isNumber(l.budgeted) ? workingCents + toCents(l.budgeted) : null
    }

    const clean = blockers.size === 0
    const sourceComplete = items.length > 0 && unpricedCount === 0 && !invalid
    let state = TRANSFER_ROW_STATE.BLOCKED
    if (clean) {
      if (items.length === 0) state = sourcedCents === 0 ? TRANSFER_ROW_STATE.UNCHANGED : TRANSFER_ROW_STATE.ZERO_AVAILABLE
      else if (!sourced) state = TRANSFER_ROW_STATE.CREATE
      else state = sourcedCents === boqCents ? TRANSFER_ROW_STATE.UNCHANGED : TRANSFER_ROW_STATE.REFRESH
    }

    const info = boqSourceInfo(sourced)
    const itemName = items.find(i => typeof i.costCodeName === 'string' && i.costCodeName)?.costCodeName
    const lineName = lines.find(l => typeof l.costCodeName === 'string' && l.costCodeName)?.costCodeName
    rows.push({
      costCodeId,
      costCodeName: cc ? costCodeDisplayName(cc) : (itemName || lineName || 'Unknown cost code'),
      lineId: boqBudgetLineId(costCodeId),
      state,
      blockers: [...blockers].sort(cmp),
      itemCount: items.length,
      unpricedCount,
      // The BOQ amount for the code: a number only when EVERY active item is
      // priced and usable — never a partial sum.
      boqCents: sourceComplete ? boqCents : null,
      workingCents,
      hasSourcedLine: Boolean(sourced),
      sourcedCents,
      manualLineCount: manual.length,
      manuallyChanged: info.isBoqSourced && info.manuallyChanged,
      latestTransferCents: info.latest && isNumber(info.latest.amount) ? toCents(info.latest.amount) : null,
      fingerprint: sourceFingerprint(costCodeId, items),
    })
  }

  rows.sort((a, b) => a.costCodeName.localeCompare(b.costCodeName) || cmp(a.costCodeId, b.costCodeId))
  return { currencyCode, rows, reviewKey: reviewKeyOf(currencyCode, rows) }
}

// ── reviewKey ────────────────────────────────────────────────────────────────
//
// The deterministic identity of ONE reviewed proposal. The browser sends it;
// the callable recomputes it from its own transactional reads and refuses the
// request (stale review, nothing written) unless they are equal.
//
// CANONICAL INPUTS, in this order:
//   1. the key version and the project currency code;
//   2. for every row, sorted by costCodeId (code-unit order, not locale):
//        costCodeId · state · blockers (sorted, comma-joined) · itemCount ·
//        BOQ amount in whole cents · working amount on the code in whole cents ·
//        the BOQ-sourced line's amount in whole cents · the source fingerprint
//      with "x" for a value that does not exist.
// EXCLUDED on purpose: timestamps, actors, display names, descriptions, notes,
// document read order, and the reviewer's set-to-zero choices (those travel in
// the request beside the key, and `transferRequestKey` binds the two).
const centsKey = (c) => (c === null || c === undefined ? 'x' : String(c))

function reviewKeyOf(currencyCode, rows) {
  const parts = [...rows].sort((a, b) => cmp(a.costCodeId, b.costCodeId)).map(r => [
    r.costCodeId, r.state, r.blockers.join(','), String(r.itemCount),
    centsKey(r.boqCents), centsKey(r.workingCents), centsKey(r.sourcedCents), r.fingerprint,
  ].join('~'))
  return `${BOQ_TRANSFER_VERSION}:${digest([BOQ_TRANSFER_VERSION, String(currencyCode ?? ''), String(parts.length), ...parts].join('|'))}`
}

export const isReviewKeyShape = (v) => typeof v === 'string' && /^v1:[0-9a-f]{32}$/.test(v)

// The set-to-zero choices as the request carries them: unique, sorted.
export const normaliseZeroChoices = (ids) => [...new Set((ids ?? []).filter(id => typeof id === 'string' && id))].sort(cmp)

// The identity of one REQUEST: the reviewed proposal plus the set-to-zero
// choices made on it. Stored on every line the request writes, so a repeat of
// the same request can be recognised after it has been applied.
//
// ADR-97: a request that names an approved estimate revision as its source is
// a DIFFERENT request from one that does not (its provenance differs), so the
// estimate id is part of the key — appended only when present, which leaves
// every key computed before ADR-97 unchanged.
export const transferRequestKey = (reviewKey, setToZero, estimateId = null) =>
  `r1:${digest([String(reviewKey ?? ''), ...normaliseZeroChoices(setToZero), ...(estimateId ? [`estimate:${estimateId}`] : [])].join('|'))}`

// ── Operations ───────────────────────────────────────────────────────────────

export const TRANSFER_OPERATION = { CREATE: 'create', REFRESH: 'refresh', ZERO: 'zero' }

// The writes a request stands for: every create and refresh row, plus a zero
// for each ticked cost code. A ticked code that is not `zero-available` makes
// the whole request invalid — nothing is dropped silently.
export function transferOperations(proposal, setToZero = []) {
  const zero = normaliseZeroChoices(setToZero)
  const byId = new Map((proposal?.rows ?? []).map(r => [r.costCodeId, r]))
  const invalidZero = zero.filter(id => byId.get(id)?.state !== TRANSFER_ROW_STATE.ZERO_AVAILABLE)
  if (invalidZero.length > 0) return { ok: false, invalidZero, operations: [] }

  const operations = []
  for (const row of proposal?.rows ?? []) {
    const base = { costCodeId: row.costCodeId, costCodeName: row.costCodeName, lineId: row.lineId, itemCount: row.itemCount, fingerprint: row.fingerprint, fromCents: row.sourcedCents }
    if (row.state === TRANSFER_ROW_STATE.CREATE) operations.push({ ...base, type: TRANSFER_OPERATION.CREATE, cents: row.boqCents, amount: centsToAmount(row.boqCents) })
    else if (row.state === TRANSFER_ROW_STATE.REFRESH) operations.push({ ...base, type: TRANSFER_OPERATION.REFRESH, cents: row.boqCents, amount: centsToAmount(row.boqCents) })
    else if (row.state === TRANSFER_ROW_STATE.ZERO_AVAILABLE && zero.includes(row.costCodeId)) operations.push({ ...base, type: TRANSFER_OPERATION.ZERO, cents: 0, amount: 0 })
  }
  operations.sort((a, b) => cmp(a.costCodeId, b.costCodeId))
  return { ok: true, invalidZero: [], operations }
}

// The budget-line register as it will stand once `operations` are written —
// used ONLY to derive the key of the resulting state (`resultKey`).
export function applyOperationsToLines(budgetLines, operations) {
  const next = (budgetLines ?? []).map(l => ({ ...l }))
  for (const op of operations ?? []) {
    const existing = next.find(l => l.id === op.lineId)
    if (existing) existing.budgeted = op.amount
    else next.push({ id: op.lineId, costCodeId: op.costCodeId, costCodeName: op.costCodeName, budgeted: op.amount, boqSource: {} })
  }
  return next
}

// The reviewKey the SAME registers will produce after `operations` commit.
export function resultKeyAfter({ boqItems, budgetLines, costCodes, currencyCode }, operations) {
  return buildTransferProposal({ boqItems, budgetLines: applyOperationsToLines(budgetLines, operations), costCodes, currencyCode }).reviewKey
}

// ── Already-applied recognition ──────────────────────────────────────────────
//
// A repeat of a request that DID commit no longer matches the current
// reviewKey (its create rows are now unchanged rows). It is recognised as
// already applied only when BOTH hold:
//   · a BOQ-sourced line carries this request's key as its latest transfer; and
//   · the state that transfer produced (`resultKey`, stored with it) is the
//     CURRENT state — so no BOQ item, working line or cost code has changed
//     since.
// A later BOQ edit, a manual edit of a working line, or any other transfer
// changes the current key, and the repeat is then a STALE REVIEW, never
// "already applied".
export function findAppliedRequest(budgetLines, requestKey, currentReviewKey) {
  for (const line of budgetLines ?? []) {
    const latest = boqSourceInfo(line).latest
    if (latest && latest.requestKey === requestKey && latest.resultKey === currentReviewKey) {
      return { lineId: line.id, by: latest.by ?? null }
    }
  }
  return null
}

// ── Totals for the review dialog and the audit event ─────────────────────────

const sum = (list, pick) => list.reduce((s, x) => s + (pick(x) ?? 0), 0)

export function transferSummary(proposal, setToZero = []) {
  const rows = proposal?.rows ?? []
  const { ok, operations } = transferOperations(proposal, setToZero)
  const of = (type) => operations.filter(o => o.type === type)
  const blocked = rows.filter(r => r.state === TRANSFER_ROW_STATE.BLOCKED)
  return {
    valid: ok,
    rowCount: rows.length,
    createCount: of(TRANSFER_OPERATION.CREATE).length,
    refreshCount: of(TRANSFER_OPERATION.REFRESH).length,
    zeroCount: of(TRANSFER_OPERATION.ZERO).length,
    operationCount: operations.length,
    unchangedCount: rows.filter(r => r.state === TRANSFER_ROW_STATE.UNCHANGED).length,
    zeroAvailableCount: rows.filter(r => r.state === TRANSFER_ROW_STATE.ZERO_AVAILABLE).length,
    blockedCount: blocked.length,
    // The operations' own before / after, in whole cents.
    beforeCents: sum(operations, o => o.fromCents),
    afterCents: sum(operations, o => o.cents),
    // BOQ value that is NOT transferred because its cost code is blocked
    // (codes with unpriced or invalid items contribute nothing — never a guess).
    blockedBoqCents: sum(blocked, r => r.boqCents),
    blockedUnknownCount: blocked.filter(r => r.itemCount > 0 && r.boqCents === null).length,
  }
}

// ── Request validation (shared by the browser action and the callable) ───────

export const BOQ_TRANSFER_REQUEST_KEYS = ['projectId', 'reviewKey', 'setToZero']
// ADR-97 — optional: the APPROVED estimate revision this transfer is recorded
// as the handover of. The callable accepts it only while the live BOQ is still
// the BOQ that revision priced (lib/estimateSource.js); otherwise it refuses,
// and the transfer can be made without the claim. Absent = the ADR-81 transfer
// exactly as before.
export const BOQ_TRANSFER_OPTIONAL_REQUEST_KEYS = ['estimateId']
export const BOQ_TRANSFER_MAX_ZERO_CHOICES = 2000

export { resolveProjectCurrency } from './currency'
export { estimateSourceKey } from './estimateSource'
