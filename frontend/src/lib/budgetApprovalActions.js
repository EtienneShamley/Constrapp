import {
  BUDGET_APPROVAL_STATUS, validateBudgetApprovalDraft, normaliseBudgetApprovalDraft, validateBudgetWithdrawReason,
  buildBudgetCapturePayload, budgetDrift, isBudgetSnapshotUsable, budgetSupersessionKey,
} from './budgetApproval'
import { sameActivityVersion, activityRevision, QUICK_ACTION_ERROR, QUICK_ACTION_ERROR_MESSAGES, quickActionErrorKind } from './projectTimeline'
import { QuickActionError } from './activityQuickActions'

// ── Approved Budget writes — capture, approve, withdraw (ADR-70) ─────────────
//
// Three guarded writes, SDK injected (`runTransaction`, `serverTimestamp`,
// `getDocsFromServer`, the document refs and the register queries), so this
// module imports no Firebase code: the hook passes the app SDK and the
// emulator suite passes the test SDK and exercises the real transactions.
//
// CAPTURE — one FRESH SERVER READ of the working budget lines AND the company
// cost codes, then ONE transaction creating the header and the snapshot:
//
//   1. getDocsFromServer(budgetLinesQuery) + getDocsFromServer(costCodesQuery)
//      — the server copy, never the cache (an offline client fails here).
//   2. buildBudgetCapturePayload: every line projected and validated; a
//      malformed line, a missing cost code or a duplicate id REFUSES the
//      capture with the records named; the payload is sized.
//   3. tx.set(header, draft) + tx.set(snapshot, payload) in one transaction.
//      Rules require the pair (getAfter in both directions), the same actor
//      and server time on both, and the count / total / currency to agree.
//
// ⚠️ RESIDUAL RACE, STATED PLAINLY. The query and the write are two requests:
// a line edited between them is captured as the query saw it. The approver
// sees it as DRIFT (budgetDrift compares every entry to the live register),
// the rules pin the two end entries to their source lines, and the approve
// transaction refuses a drift the approver did not acknowledge by key. No
// claim is made that the snapshot equals the register at commit time (DC44).
//
// APPROVE — a fresh server read of the budget lines FIRST (the drift the
// approver must review), which must match the drift acknowledged; then ONE
// transaction that reads the header (must exist, be a draft, be the version
// the reviewer saw — revision AND stamps), the snapshot (must exist with the
// header's count), and the POINTER (`approvedBudget/current` — the common
// concurrency boundary: its `versionCount` must be the one the reviewer saw,
// so two simultaneous approvals cannot both land, and a client that saw an
// older active version is refused and must re-review); then flips the header
// to approved with `version = versionCount + 1` and creates or advances the
// pointer. The transaction is atomic: a timeout after commit never creates a
// second version, because a retry re-reads the header (now approved → refused)
// and the pointer (advanced → stale).
//
// SUPERSESSION (SHIELD 2B2, ADR-71). A re-approval RESETS the pointer's
// adjustment ledger to zero: every approved adjustment of the replaced
// version is superseded (kept, never counted again). The transaction also
// requires the pointer's ledger (count and net) to be the one the reviewer
// saw — SUPERSEDED otherwise — and, when approved adjustments exist, the
// reviewer's acknowledgement key to equal the key recomputed from the
// SERVER's pointer, the base total and the draft's total — SUPERSESSION
// otherwise. That is a client-side acknowledgement that the figures were
// shown, not a rules-proven assertion that they were understood (DC45).
//
// WITHDRAW — the same header guard, status → withdrawn with a reason.
//
// Every callback has NO side effects beyond the transaction; on any refusal
// nothing is written.

export const BUDGET_APPROVAL_ERROR = {
  ...QUICK_ACTION_ERROR,
  DRIFT:        'drift',         // the working budget changed since the approver reviewed it
  OVERSIZED:    'oversized',     // the capture would exceed the document ceiling
  SUPERSEDED:   'superseded',    // another version (or adjustment) was approved since the reviewer opened the draft
  SUPERSESSION: 'supersession',  // approved adjustments would be superseded and the reviewer has not acknowledged THIS supersession
}

export const BUDGET_APPROVAL_ERROR_MESSAGES = {
  ...QUICK_ACTION_ERROR_MESSAGES,
  [BUDGET_APPROVAL_ERROR.PENDING]:    'This approval is still saving. Wait a moment and try again.',
  [BUDGET_APPROVAL_ERROR.MISSING]:    'This budget approval no longer exists. Nothing was changed.',
  [BUDGET_APPROVAL_ERROR.STALE]:      'Someone else changed this budget approval after it was loaded. Nothing was changed — review the latest version and try again.',
  [BUDGET_APPROVAL_ERROR.INVALID]:    'This budget approval cannot be written as it stands. Nothing was written.',
  [BUDGET_APPROVAL_ERROR.PERMISSION]: 'You do not have permission to do this. Nothing was changed. If this page was open before an update, reload it and try again.',
  [BUDGET_APPROVAL_ERROR.OFFLINE]:    'You appear to be offline. The budget must be read from the server — nothing was written. Reconnect and try again.',
  [BUDGET_APPROVAL_ERROR.UNKNOWN]:    'The budget approval could not be written. Nothing was changed.',
  [BUDGET_APPROVAL_ERROR.DRIFT]:      'The working budget changed again after you reviewed it. Nothing was approved — review the changes and try again.',
  [BUDGET_APPROVAL_ERROR.OVERSIZED]:  'This budget is too large for a single approval. Nothing was written and nothing was truncated.',
  [BUDGET_APPROVAL_ERROR.SUPERSEDED]: 'Another budget version or adjustment was approved while you were reviewing this draft. Nothing was approved — review the draft against the new current figures and try again.',
  [BUDGET_APPROVAL_ERROR.SUPERSESSION]: 'This version would supersede approved budget adjustments. Nothing was approved — review and acknowledge the change against the current adjusted approved budget, then try again.',
}

export class BudgetApprovalWriteError extends QuickActionError {
  constructor(kind, message, cause, details = null) {
    super(kind, message ?? BUDGET_APPROVAL_ERROR_MESSAGES[kind] ?? BUDGET_APPROVAL_ERROR_MESSAGES[BUDGET_APPROVAL_ERROR.UNKNOWN], cause)
    this.name = 'BudgetApprovalWriteError'
    if (details) this.details = details
  }
}

// ── Server reads ─────────────────────────────────────────────────────────────

const docsOf = (snap) => snap.docs.map(d => ({ id: d.id, ...d.data() }))

// The working budget lines (and optionally the cost codes) as the SERVER
// holds them. Unreachable → OFFLINE, denied → PERMISSION; never the cache.
export async function readBudgetFromServer({ budgetLinesQuery, costCodesQuery = null, getDocsFromServer }) {
  try {
    const lines = docsOf(await getDocsFromServer(budgetLinesQuery))
    const codes = costCodesQuery ? docsOf(await getDocsFromServer(costCodesQuery)) : null
    return { budgetLines: lines, costCodes: codes }
  } catch (err) {
    throw new BudgetApprovalWriteError(quickActionErrorKind(err?.code), undefined, err)
  }
}

async function guarded(runTransaction, db, body) {
  let outcome
  try {
    outcome = await runTransaction(db, body)
  } catch (err) {
    if (err instanceof BudgetApprovalWriteError) throw err
    throw new BudgetApprovalWriteError(quickActionErrorKind(err?.code), undefined, err)
  }
  if (outcome.kind) {
    throw new BudgetApprovalWriteError(
      outcome.kind,
      outcome.reason ? `${BUDGET_APPROVAL_ERROR_MESSAGES[outcome.kind]} ${outcome.reason}` : undefined,
      undefined,
      outcome.details ?? null,
    )
  }
  return outcome
}

// ── CAPTURE ──────────────────────────────────────────────────────────────────

// Returns { id, counts, total, bytes }. `headerRef` and `snapshotRef` share
// one random id (the hook mints it). `currencyCode` is the project's RESOLVED
// currency; rules pin the header's `currency` to it.
export async function runBudgetCapture({
  db, headerRef, snapshotRef, budgetLinesQuery, costCodesQuery, getDocsFromServer,
  input, uid, currencyCode, runTransaction, serverTimestamp,
}) {
  if (!uid) throw new BudgetApprovalWriteError(BUDGET_APPROVAL_ERROR.PERMISSION)
  if (typeof currencyCode !== 'string' || !/^[A-Z]{3}$/.test(currencyCode)) {
    throw new BudgetApprovalWriteError(BUDGET_APPROVAL_ERROR.INVALID, `${BUDGET_APPROVAL_ERROR_MESSAGES[BUDGET_APPROVAL_ERROR.INVALID]} The project currency is not resolved.`)
  }
  const draftError = validateBudgetApprovalDraft(input)
  if (draftError) throw new BudgetApprovalWriteError(BUDGET_APPROVAL_ERROR.INVALID, `${BUDGET_APPROVAL_ERROR_MESSAGES[BUDGET_APPROVAL_ERROR.INVALID]} ${draftError}`)
  const { reason } = normaliseBudgetApprovalDraft(input)

  // 1. The server copy of the register and the cost-code library.
  const { budgetLines, costCodes } = await readBudgetFromServer({ budgetLinesQuery, costCodesQuery, getDocsFromServer })

  // 2. Project, validate, size — refuses with the records named.
  const payload = buildBudgetCapturePayload(budgetLines, costCodes, { capturedBy: uid, currency: currencyCode })
  if (!payload.ok) {
    const kind = payload.errors.length === 0 && payload.entries.length > 0 ? BUDGET_APPROVAL_ERROR.OVERSIZED : BUDGET_APPROVAL_ERROR.INVALID
    throw new BudgetApprovalWriteError(kind, payload.refusal, undefined, { errors: payload.errors, counts: payload.counts, bytes: payload.bytes })
  }

  // 3. The pair, in one transaction. No reads: the id is fresh and random,
  //    and rules verify the pair with getAfter() in both directions.
  await guarded(runTransaction, db, async (tx) => {
    tx.set(headerRef, {
      reason,
      status: BUDGET_APPROVAL_STATUS.DRAFT,
      currency: currencyCode,
      entryCount: payload.entries.length,
      total: payload.total,
      version: null,
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
    tx.set(snapshotRef, {
      entryCount: payload.entries.length,
      total: payload.total,
      currency: currencyCode,
      capturedAt: serverTimestamp(),
      capturedBy: uid,
      entries: payload.entries,
    })
    return { kind: null }
  })
  return { id: headerRef.id, counts: payload.counts, total: payload.total, bytes: payload.bytes }
}

// ── DRIFT CHECK (read-only) ──────────────────────────────────────────────────

export async function checkBudgetDrift({ budgetLinesQuery, getDocsFromServer, snapshot }) {
  if (!isBudgetSnapshotUsable(snapshot)) {
    throw new BudgetApprovalWriteError(BUDGET_APPROVAL_ERROR.INVALID, `${BUDGET_APPROVAL_ERROR_MESSAGES[BUDGET_APPROVAL_ERROR.INVALID]} The captured snapshot cannot be read.`)
  }
  const { budgetLines } = await readBudgetFromServer({ budgetLinesQuery, getDocsFromServer })
  return budgetDrift(budgetLines, snapshot)
}

// ── Header guard (shared by approve and withdraw) ────────────────────────────

async function readDraftHeader(tx, headerRef, seen) {
  const snap = await tx.get(headerRef)
  if (!snap.exists()) return { kind: BUDGET_APPROVAL_ERROR.MISSING }
  const current = { id: snap.id, ...snap.data() }
  if (!sameActivityVersion(seen, current)) return { kind: BUDGET_APPROVAL_ERROR.STALE }
  if (current.status !== BUDGET_APPROVAL_STATUS.DRAFT) {
    return { kind: BUDGET_APPROVAL_ERROR.INVALID, reason: `This budget approval is already ${current.status}.` }
  }
  return { kind: null, current }
}

// ── APPROVE ──────────────────────────────────────────────────────────────────

// `seen` is the header the reviewer opened; `snapshot` its loaded payload;
// `acknowledgedDriftKey` the drift the reviewer explicitly reviewed ('' when
// they reviewed "no changes"); `seenVersionCount` the pointer's versionCount
// the reviewer opened the draft against (0 when no version existed);
// `seenAdjustmentCount` / `seenAdjustmentNet` / `seenBaseTotal` the active
// version's ledger and base total the reviewer compared against (ADR-71), and
// `acknowledgedSupersessionKey` the supersession they acknowledged ('' when
// no approved adjustment existed). Returns { version }.
export async function runBudgetApprove({
  db, headerRef, snapshotRef, pointerRef, budgetLinesQuery, getDocsFromServer,
  seen, snapshot, acknowledgedDriftKey = '', seenVersionCount = 0,
  seenAdjustmentCount = 0, seenAdjustmentNet = 0, seenBaseTotal = null, acknowledgedSupersessionKey = '',
  uid, runTransaction, serverTimestamp,
}) {
  if (!uid) throw new BudgetApprovalWriteError(BUDGET_APPROVAL_ERROR.PERMISSION)
  if (!seen?.updatedAt) throw new BudgetApprovalWriteError(BUDGET_APPROVAL_ERROR.PENDING)

  // Fresh server read: the drift as it stands NOW must be the drift the
  // approver acknowledged.
  const drift = await checkBudgetDrift({ budgetLinesQuery, getDocsFromServer, snapshot })
  if (drift.key !== (acknowledgedDriftKey ?? '')) {
    throw new BudgetApprovalWriteError(BUDGET_APPROVAL_ERROR.DRIFT, undefined, undefined, { drift })
  }

  const outcome = await guarded(runTransaction, db, async (tx) => {
    // Every read before any write (Firestore transaction contract).
    const header = await readDraftHeader(tx, headerRef, seen)
    if (header.kind) return header
    const payload = await tx.get(snapshotRef)
    if (!payload.exists()) return { kind: BUDGET_APPROVAL_ERROR.INVALID, reason: 'The captured snapshot is missing.' }
    const p = payload.data() ?? {}
    if (p.entryCount !== header.current.entryCount || p.total !== header.current.total || p.currency !== header.current.currency) {
      return { kind: BUDGET_APPROVAL_ERROR.INVALID, reason: 'The captured snapshot does not match this approval.' }
    }
    const pointerSnap = await tx.get(pointerRef)
    const pointer = pointerSnap.exists() ? pointerSnap.data() : null
    const currentCount = pointer ? pointer.versionCount : 0
    // The common concurrency boundary: a version approved since the reviewer
    // opened this draft is refused, never silently stacked on.
    if (!Number.isInteger(currentCount) || currentCount < 0) {
      return { kind: BUDGET_APPROVAL_ERROR.INVALID, reason: 'The approved-budget pointer is malformed.' }
    }
    if (currentCount !== (seenVersionCount ?? 0)) return { kind: BUDGET_APPROVAL_ERROR.SUPERSEDED }
    // ADR-71: the active version's adjustment ledger (absent = 0) must be the
    // one the reviewer compared against; when it is not empty, the reviewer
    // must have acknowledged THIS supersession.
    const ledgerCount = pointer ? (pointer.adjustmentCount ?? 0) : 0
    const ledgerNet = pointer ? (pointer.adjustmentNet ?? 0) : 0
    if (!Number.isInteger(ledgerCount) || ledgerCount < 0 || typeof ledgerNet !== 'number' || !Number.isFinite(ledgerNet)) {
      return { kind: BUDGET_APPROVAL_ERROR.INVALID, reason: 'The approved-budget pointer is malformed.' }
    }
    if (ledgerCount !== (seenAdjustmentCount ?? 0) || Math.round(ledgerNet * 100) !== Math.round((Number(seenAdjustmentNet) || 0) * 100)) {
      return { kind: BUDGET_APPROVAL_ERROR.SUPERSEDED }
    }
    if (ledgerCount > 0) {
      const expected = budgetSupersessionKey({
        versionCount: currentCount, adjustmentCount: ledgerCount, adjustmentNet: ledgerNet,
        baseTotal: seenBaseTotal, proposedTotal: header.current.total,
      })
      if (acknowledgedSupersessionKey !== expected) return { kind: BUDGET_APPROVAL_ERROR.SUPERSESSION }
    }

    const version = currentCount + 1
    const revision = activityRevision(header.current) + 1
    tx.update(headerRef, {
      status: BUDGET_APPROVAL_STATUS.APPROVED,
      version,
      approvedAt: serverTimestamp(),
      approvedBy: uid,
      revision,
      updatedAt: serverTimestamp(),
      updatedBy: uid,
    })
    if (pointer) {
      tx.update(pointerRef, {
        activeApprovalId: headerRef.id,
        versionCount: version,
        approvedAt: serverTimestamp(),
        approvedBy: uid,
        // ADR-71: the new version starts with an EMPTY adjustment ledger —
        // the replaced version's adjustments are superseded (rules require it).
        adjustmentCount: 0,
        adjustmentNet: 0,
        lastAdjustmentId: null,
        updatedAt: serverTimestamp(),
        updatedBy: uid,
      })
    } else {
      tx.set(pointerRef, {
        activeApprovalId: headerRef.id,
        originalApprovalId: headerRef.id,
        versionCount: 1,
        approvedAt: serverTimestamp(),
        approvedBy: uid,
        createdAt: serverTimestamp(),
        createdBy: uid,
        updatedAt: serverTimestamp(),
        updatedBy: uid,
      })
    }
    return { kind: null, version }
  })
  return { version: outcome.version }
}

// ── WITHDRAW ─────────────────────────────────────────────────────────────────

export async function runBudgetWithdraw({ db, headerRef, seen, reason, uid, runTransaction, serverTimestamp }) {
  if (!uid) throw new BudgetApprovalWriteError(BUDGET_APPROVAL_ERROR.PERMISSION)
  if (!seen?.updatedAt) throw new BudgetApprovalWriteError(BUDGET_APPROVAL_ERROR.PENDING)
  const reasonError = validateBudgetWithdrawReason(reason)
  if (reasonError) throw new BudgetApprovalWriteError(BUDGET_APPROVAL_ERROR.INVALID, `${BUDGET_APPROVAL_ERROR_MESSAGES[BUDGET_APPROVAL_ERROR.INVALID]} ${reasonError}`)

  const outcome = await guarded(runTransaction, db, async (tx) => {
    const header = await readDraftHeader(tx, headerRef, seen)
    if (header.kind) return header
    const revision = activityRevision(header.current) + 1
    tx.update(headerRef, {
      status: BUDGET_APPROVAL_STATUS.WITHDRAWN,
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
