import { roundMoney } from './purchaseOrders'
import {
  BUDGET_ADJUSTMENT_STATUS, validateBudgetAdjustmentDraft, normaliseBudgetAdjustmentDraft,
  validateBudgetAdjustmentRecord, validateBudgetAdjustmentWithdrawReason, adjustmentNet, adjustmentPreview,
} from './budgetAdjustment'
import { resolveBudgetSource, BUDGET_SOURCE, BUDGET_INTEGRITY_PROBLEM_TEXT } from './budgetApproval'
import { sameActivityVersion, activityRevision, QUICK_ACTION_ERROR, QUICK_ACTION_ERROR_MESSAGES, quickActionErrorKind } from './projectTimeline'
import { QuickActionError } from './activityQuickActions'

// ── Approved Budget ADJUSTMENT writes — prepare, approve, withdraw (ADR-71) ──
//
// Three guarded writes, SDK injected (`runTransaction`, `serverTimestamp`,
// `getDocFromServer`, `getDocsFromServer`, the document refs and queries),
// so this module imports no Firebase code: the hook passes the app SDK and
// the emulator suite passes the test SDK and runs the real transactions.
//
// PREPARE — a FRESH SERVER READ of the company cost codes (existence and the
// frozen names), then ONE transaction that reads the adjustment's OWN id
// (minted ONCE per dialog, so a double-click or a retry after a timed-out
// commit finds its own draft and writes nothing) and the POINTER (no pointer
// → NO_BASE: there is no approved version to adjust), and creates the draft
// bound to the pointer's ACTIVE version (baseApprovalId / baseVersion — the
// rules pin both to the live pointer).
//
// APPROVE — first a FRESH SERVER READ of the authoritative state: the
// pointer, the active header and snapshot, and every adjustment of the
// active version, resolved through THE adapter (resolveBudgetSource) — so
// the ledger is reconciled against the records exactly as every consumer
// reconciles it. The movement is previewed against that adjusted per-code
// figure; a cost code driven below zero is REFUSED (NEGATIVE — client-only,
// DC45: rules cannot sum sibling records). Then ONE transaction that reads
// the adjustment (exists, still a draft, the version the approver saw) and
// the POINTER — its active version must still be the draft's base
// (STALE_BASE otherwise: a re-approval replaced it) and its ledger must still
// be the count and net the preview was computed from (SUPERSEDED otherwise:
// another adjustment was approved — re-read and review again) — then writes
// the adjustment approved as sequence = count + 1 and advances the ledger by
// exactly one and by exactly the derived net. Rules pair the two writes with
// getAfter() in both directions.
//
// A retry of an approval that already committed is refused (the adjustment is
// no longer the draft the approver saw) — the movement is never applied
// twice, and the ledger cannot advance without its paired record.
//
// WITHDRAW — the same guard, status → withdrawn with a reason. A STALE draft
// (base no longer active) can only be withdrawn.
//
// Every transaction callback reads before it writes and has no side effects
// beyond the transaction; on any refusal nothing is written.

export const BUDGET_ADJUSTMENT_ERROR = {
  ...QUICK_ACTION_ERROR,
  NO_BASE:    'no_base',     // no approved budget version exists to adjust
  STALE_BASE: 'stale_base',  // the active version is no longer the draft's base
  SUPERSEDED: 'superseded',  // another adjustment was approved meanwhile
  NEGATIVE:   'negative',    // a cost code's adjusted approved budget would fall below zero
}

export const BUDGET_ADJUSTMENT_ERROR_MESSAGES = {
  ...QUICK_ACTION_ERROR_MESSAGES,
  [BUDGET_ADJUSTMENT_ERROR.PENDING]:    'This adjustment is still saving. Wait a moment and try again.',
  [BUDGET_ADJUSTMENT_ERROR.MISSING]:    'This budget adjustment no longer exists. Nothing was changed.',
  [BUDGET_ADJUSTMENT_ERROR.STALE]:      'Someone else changed this budget adjustment after it was loaded. Nothing was changed — review the latest version and try again.',
  [BUDGET_ADJUSTMENT_ERROR.INVALID]:    'This budget adjustment cannot be written as it stands. Nothing was written.',
  [BUDGET_ADJUSTMENT_ERROR.PERMISSION]: 'You do not have permission to do this. Nothing was changed. If this page was open before an update, reload it and try again.',
  [BUDGET_ADJUSTMENT_ERROR.OFFLINE]:    'You appear to be offline. The approved budget must be read from the server — nothing was written. Reconnect and try again.',
  [BUDGET_ADJUSTMENT_ERROR.UNKNOWN]:    'The budget adjustment could not be written. Nothing was changed.',
  [BUDGET_ADJUSTMENT_ERROR.NO_BASE]:    'This project has no approved budget version, so there is nothing to adjust. Approve a budget version first.',
  [BUDGET_ADJUSTMENT_ERROR.STALE_BASE]: 'A new budget version has been approved since this adjustment was prepared. It cannot be approved against the new version — withdraw it and prepare a new one if it is still needed.',
  [BUDGET_ADJUSTMENT_ERROR.SUPERSEDED]: 'Another budget adjustment was approved while you were reviewing this one. Nothing was approved — review the updated figures and try again.',
  [BUDGET_ADJUSTMENT_ERROR.NEGATIVE]:   'Approving this adjustment would take a cost code\'s approved budget below zero. Nothing was approved.',
}

export class BudgetAdjustmentWriteError extends QuickActionError {
  constructor(kind, message, cause, details = null) {
    super(kind, message ?? BUDGET_ADJUSTMENT_ERROR_MESSAGES[kind] ?? BUDGET_ADJUSTMENT_ERROR_MESSAGES[BUDGET_ADJUSTMENT_ERROR.UNKNOWN], cause)
    this.name = 'BudgetAdjustmentWriteError'
    if (details) this.details = details
  }
}

const withReason = (kind, reason) => `${BUDGET_ADJUSTMENT_ERROR_MESSAGES[kind]} ${reason}`
const toCents = (n) => Math.round((Number(n) || 0) * 100)

async function guarded(runTransaction, db, body) {
  let outcome
  try {
    outcome = await runTransaction(db, body)
  } catch (err) {
    if (err instanceof BudgetAdjustmentWriteError) throw err
    throw new BudgetAdjustmentWriteError(quickActionErrorKind(err?.code), undefined, err)
  }
  if (outcome.kind) {
    throw new BudgetAdjustmentWriteError(
      outcome.kind,
      outcome.reason ? withReason(outcome.kind, outcome.reason) : undefined,
      undefined,
      outcome.details ?? null,
    )
  }
  return outcome
}

// A server read; unreachable → OFFLINE, denied → PERMISSION; never the cache.
async function fromServer(fn) {
  try {
    return await fn()
  } catch (err) {
    throw new BudgetAdjustmentWriteError(quickActionErrorKind(err?.code), undefined, err)
  }
}

const docData = (snap) => (snap.exists() ? { id: snap.id, ...snap.data() } : null)
const docsOf = (snap) => snap.docs.map(d => ({ id: d.id, ...d.data() }))

// ── PREPARE ──────────────────────────────────────────────────────────────────

// `adjustmentRef` carries the id minted ONCE for this submission. `seenBase`
// (optional) is the active approval id the preparer previewed against; a
// different active version refuses with STALE_BASE. Returns { id, existing }.
export async function runBudgetAdjustmentPrepare({
  db, adjustmentRef, pointerRef, costCodesQuery, getDocsFromServer,
  input, uid, currencyCode, seenBase = null, runTransaction, serverTimestamp,
}) {
  if (!uid) throw new BudgetAdjustmentWriteError(BUDGET_ADJUSTMENT_ERROR.PERMISSION)
  if (typeof currencyCode !== 'string' || !/^[A-Z]{3}$/.test(currencyCode)) {
    throw new BudgetAdjustmentWriteError(BUDGET_ADJUSTMENT_ERROR.INVALID, withReason(BUDGET_ADJUSTMENT_ERROR.INVALID, 'The project currency is not resolved.'))
  }

  // The cost-code library as the SERVER holds it: existence and frozen names.
  const codes = docsOf(await fromServer(() => getDocsFromServer(costCodesQuery)))
  const codeMap = new Map(codes.filter(c => c?.id).map(c => [c.id, c]))
  const problem = validateBudgetAdjustmentDraft(input, codeMap)
  if (problem) throw new BudgetAdjustmentWriteError(BUDGET_ADJUSTMENT_ERROR.INVALID, withReason(BUDGET_ADJUSTMENT_ERROR.INVALID, problem))
  const fields = normaliseBudgetAdjustmentDraft(input, codeMap)

  const outcome = await guarded(runTransaction, db, async (tx) => {
    // Every read before any write.
    const own = await tx.get(adjustmentRef)
    const pointerSnap = await tx.get(pointerRef)
    if (own.exists()) {
      // The SAME submission (its id is minted once): a double-click or a
      // retry after a commit that did land. Nothing more is written.
      if (own.data()?.createdBy === uid) return { kind: null, existing: true }
      return { kind: BUDGET_ADJUSTMENT_ERROR.INVALID, reason: 'This adjustment id is already in use.' }
    }
    if (!pointerSnap.exists()) return { kind: BUDGET_ADJUSTMENT_ERROR.NO_BASE }
    const pointer = pointerSnap.data() ?? {}
    if (typeof pointer.activeApprovalId !== 'string' || !pointer.activeApprovalId || !Number.isInteger(pointer.versionCount)) {
      return { kind: BUDGET_ADJUSTMENT_ERROR.INVALID, reason: 'The approved-budget pointer is malformed.' }
    }
    if (seenBase && seenBase !== pointer.activeApprovalId) return { kind: BUDGET_ADJUSTMENT_ERROR.STALE_BASE }

    tx.set(adjustmentRef, {
      ...fields,
      currency: currencyCode,
      baseApprovalId: pointer.activeApprovalId,
      baseVersion: pointer.versionCount,
      sequence: null,
      status: BUDGET_ADJUSTMENT_STATUS.DRAFT,
      approvedAt: null,
      approvedBy: null,
      withdrawnAt: null,
      withdrawnBy: null,
      withdrawReason: '',
      revision: 1,
      createdAt: serverTimestamp(),
      createdBy: uid,
      updatedAt: serverTimestamp(),
      updatedBy: uid,
    })
    return { kind: null, existing: false }
  })
  return { id: adjustmentRef.id, existing: outcome.existing }
}

// ── The authoritative adjusted state, fresh from the server ──────────────────

// The pointer, the active header and snapshot, and EVERY adjustment of the
// active version, resolved through THE shared adapter. Returns
// { pointer, resolved }; refuses when there is no pointer or the records do
// not reconcile (never a partial figure).
export async function readAdjustedBudgetFromServer({
  pointerRef, approvalHeaderRef, approvalSnapshotRef, adjustmentsQuery,
  getDocFromServer, getDocsFromServer, currencyCode,
}) {
  const pointer = docData(await fromServer(() => getDocFromServer(pointerRef)))
  if (!pointer) throw new BudgetAdjustmentWriteError(BUDGET_ADJUSTMENT_ERROR.NO_BASE)
  const activeId = typeof pointer.activeApprovalId === 'string' ? pointer.activeApprovalId : ''
  if (!activeId) {
    throw new BudgetAdjustmentWriteError(BUDGET_ADJUSTMENT_ERROR.INVALID, withReason(BUDGET_ADJUSTMENT_ERROR.INVALID, 'The approved-budget pointer is malformed.'))
  }
  const [header, snapshot, adjustments] = await Promise.all([
    fromServer(() => getDocFromServer(approvalHeaderRef(activeId))).then(docData),
    fromServer(() => getDocFromServer(approvalSnapshotRef(activeId))).then(docData),
    fromServer(() => getDocsFromServer(adjustmentsQuery(activeId))).then(docsOf),
  ])
  const resolved = resolveBudgetSource({ approvedBudget: { pointer, header, snapshot, adjustments }, currencyCode })
  if (resolved.kind !== BUDGET_SOURCE.APPROVED) {
    const text = resolved.problems.map(p => BUDGET_INTEGRITY_PROBLEM_TEXT[p] ?? p).join(' ')
    throw new BudgetAdjustmentWriteError(
      BUDGET_ADJUSTMENT_ERROR.INVALID,
      withReason(BUDGET_ADJUSTMENT_ERROR.INVALID, `The approved budget records do not reconcile. ${text}`.trim()),
      undefined,
      { problems: resolved.problems },
    )
  }
  return { pointer, resolved }
}

// ── Draft guard (approve and withdraw) ───────────────────────────────────────

async function readDraft(tx, adjustmentRef, seen) {
  const snap = await tx.get(adjustmentRef)
  if (!snap.exists()) return { kind: BUDGET_ADJUSTMENT_ERROR.MISSING }
  const current = { id: snap.id, ...snap.data() }
  if (!sameActivityVersion(seen, current)) return { kind: BUDGET_ADJUSTMENT_ERROR.STALE }
  if (current.status !== BUDGET_ADJUSTMENT_STATUS.DRAFT) {
    return { kind: BUDGET_ADJUSTMENT_ERROR.INVALID, reason: `This adjustment is already ${current.status}.` }
  }
  return { kind: null, current }
}

// ── APPROVE ──────────────────────────────────────────────────────────────────

// `seen` is the draft the approver opened. Returns { sequence, preview }.
export async function runBudgetAdjustmentApprove({
  db, adjustmentRef, pointerRef, approvalHeaderRef, approvalSnapshotRef, adjustmentsQuery,
  getDocFromServer, getDocsFromServer, seen, uid, currencyCode, runTransaction, serverTimestamp,
}) {
  if (!uid) throw new BudgetAdjustmentWriteError(BUDGET_ADJUSTMENT_ERROR.PERMISSION)
  if (!seen?.updatedAt) throw new BudgetAdjustmentWriteError(BUDGET_ADJUSTMENT_ERROR.PENDING)
  if (seen.status !== BUDGET_ADJUSTMENT_STATUS.DRAFT) {
    throw new BudgetAdjustmentWriteError(BUDGET_ADJUSTMENT_ERROR.INVALID, withReason(BUDGET_ADJUSTMENT_ERROR.INVALID, `This adjustment is already ${seen.status}.`))
  }
  const recordProblem = validateBudgetAdjustmentRecord(seen)
  if (recordProblem) throw new BudgetAdjustmentWriteError(BUDGET_ADJUSTMENT_ERROR.INVALID, withReason(BUDGET_ADJUSTMENT_ERROR.INVALID, `The adjustment ${recordProblem}.`))

  // 1. The authoritative adjusted state, fresh, reconciled by THE adapter.
  const { pointer, resolved } = await readAdjustedBudgetFromServer({
    pointerRef, approvalHeaderRef, approvalSnapshotRef, adjustmentsQuery, getDocFromServer, getDocsFromServer, currencyCode,
  })
  if (pointer.activeApprovalId !== seen.baseApprovalId) throw new BudgetAdjustmentWriteError(BUDGET_ADJUSTMENT_ERROR.STALE_BASE)

  // 2. The resulting per-cost-code figures: none may fall below zero.
  const preview = adjustmentPreview(resolved.byCostCode, seen)
  if (!preview.ok) {
    const names = preview.negative.map(r => r.costCodeName || r.costCodeId).join(', ')
    throw new BudgetAdjustmentWriteError(BUDGET_ADJUSTMENT_ERROR.NEGATIVE, withReason(BUDGET_ADJUSTMENT_ERROR.NEGATIVE, `Affected: ${names}.`), undefined, { preview })
  }
  const seenCount = resolved.adjustmentCount
  const seenNet = resolved.adjustmentNet

  // 3. The pair, atomically, against the SAME ledger the preview used.
  const outcome = await guarded(runTransaction, db, async (tx) => {
    const draft = await readDraft(tx, adjustmentRef, seen)
    if (draft.kind) return draft
    const pointerSnap = await tx.get(pointerRef)
    if (!pointerSnap.exists()) return { kind: BUDGET_ADJUSTMENT_ERROR.NO_BASE }
    const p = pointerSnap.data() ?? {}
    if (p.activeApprovalId !== draft.current.baseApprovalId) return { kind: BUDGET_ADJUSTMENT_ERROR.STALE_BASE }
    const count = p.adjustmentCount ?? 0
    const net = p.adjustmentNet ?? 0
    if (!Number.isInteger(count) || count < 0 || typeof net !== 'number' || !Number.isFinite(net)) {
      return { kind: BUDGET_ADJUSTMENT_ERROR.INVALID, reason: 'The approved-budget pointer is malformed.' }
    }
    if (p.versionCount !== pointer.versionCount || count !== seenCount || toCents(net) !== toCents(seenNet)) {
      return { kind: BUDGET_ADJUSTMENT_ERROR.SUPERSEDED }
    }
    const movement = adjustmentNet(draft.current)
    if (movement === null) return { kind: BUDGET_ADJUSTMENT_ERROR.INVALID, reason: 'The adjustment is malformed.' }

    const sequence = count + 1
    tx.update(adjustmentRef, {
      status: BUDGET_ADJUSTMENT_STATUS.APPROVED,
      sequence,
      approvedAt: serverTimestamp(),
      approvedBy: uid,
      revision: activityRevision(draft.current) + 1,
      updatedAt: serverTimestamp(),
      updatedBy: uid,
    })
    tx.update(pointerRef, {
      adjustmentCount: sequence,
      adjustmentNet: roundMoney(net + movement),
      lastAdjustmentId: adjustmentRef.id,
      updatedAt: serverTimestamp(),
      updatedBy: uid,
    })
    return { kind: null, sequence }
  }).catch(async (err) => {
    // A commit that lost a race can be refused by the RULES (the ledger is no
    // longer +1 from the value this transaction read) rather than aborted.
    // Re-read the pointer: if the ledger or the active version moved, report
    // that truthfully instead of a permission error. Nothing was written.
    if (err?.kind !== BUDGET_ADJUSTMENT_ERROR.PERMISSION) throw err
    const now = await getDocFromServer(pointerRef).then(docData, () => { throw err })
    if (now && now.activeApprovalId !== seen.baseApprovalId) throw new BudgetAdjustmentWriteError(BUDGET_ADJUSTMENT_ERROR.STALE_BASE, undefined, err)
    if (now && ((now.adjustmentCount ?? 0) !== seenCount || toCents(now.adjustmentNet ?? 0) !== toCents(seenNet))) {
      throw new BudgetAdjustmentWriteError(BUDGET_ADJUSTMENT_ERROR.SUPERSEDED, undefined, err)
    }
    throw err
  })
  return { sequence: outcome.sequence, preview }
}

// ── WITHDRAW ─────────────────────────────────────────────────────────────────

export async function runBudgetAdjustmentWithdraw({ db, adjustmentRef, seen, reason, uid, runTransaction, serverTimestamp }) {
  if (!uid) throw new BudgetAdjustmentWriteError(BUDGET_ADJUSTMENT_ERROR.PERMISSION)
  if (!seen?.updatedAt) throw new BudgetAdjustmentWriteError(BUDGET_ADJUSTMENT_ERROR.PENDING)
  const reasonError = validateBudgetAdjustmentWithdrawReason(reason)
  if (reasonError) throw new BudgetAdjustmentWriteError(BUDGET_ADJUSTMENT_ERROR.INVALID, withReason(BUDGET_ADJUSTMENT_ERROR.INVALID, reasonError))

  const outcome = await guarded(runTransaction, db, async (tx) => {
    const draft = await readDraft(tx, adjustmentRef, seen)
    if (draft.kind) return draft
    const revision = activityRevision(draft.current) + 1
    tx.update(adjustmentRef, {
      status: BUDGET_ADJUSTMENT_STATUS.WITHDRAWN,
      withdrawnAt: serverTimestamp(),
      withdrawnBy: uid,
      withdrawReason: String(reason).trim(),
      revision,
      updatedAt: serverTimestamp(),
      updatedBy: uid,
    })
    return { kind: null, revision }
  })
  return outcome.revision
}
