import {
  FINAL_ACCOUNT_STATUS, computeFinalAccount, settledSourceStates, buildFinalAccountDraft,
  validateFinalAccountWithdrawReason, finalAccountHistory, blockerCodes,
} from './finalAccount'
import { sameActivityVersion, activityRevision, QUICK_ACTION_ERROR, QUICK_ACTION_ERROR_MESSAGES, quickActionErrorKind } from './projectTimeline'
import { QuickActionError } from './activityQuickActions'

// ── Final Account writes — prepare, withdraw, approve (ADR-77) ───────────────
//
// SDK injected (`runTransaction`, `serverTimestamp`, `getDocsFromServer`,
// `getDocFromServer`, the refs and queries, and the callable), so this module
// imports no Firebase code: the hook passes the app SDK and the emulator suite
// passes the test SDK and exercises the real transactions.
//
// PREPARE — a FRESH SERVER READ of every register the calculation uses (never
// the cache: an offline client fails here), the readiness gate, then ONE
// transaction that creates revision n: the document `finalAccounts/{n}` must
// not exist and revision n − 1 must be terminal. Rules enforce the same id /
// predecessor contract, so two people preparing at once land exactly one
// draft. The draft's figures are a PROPOSAL: nothing reads them as
// authoritative until the trusted callable has recomputed them.
//
// WITHDRAW — a draft only, by an approver or its preparer, with a reason;
// guarded by revision and stamps.
//
// APPROVE — NOT a client write. The callable `approveFinalAccount` receives
// identifiers and the revision the reviewer saw, recomputes every figure from
// records it reads itself, and writes the approved revision. Rules deny every
// client path to `approved`.

export const FINAL_ACCOUNT_ERROR = {
  ...QUICK_ACTION_ERROR,
  NOT_READY:  'notReady',   // a readiness requirement is not met
  OPEN_DRAFT: 'openDraft',  // another draft is already open
  CHANGED:    'changed',    // the records moved since the draft was prepared
  OVERSIZED:  'oversized',
  DISABLED:   'disabled',
  BUSY:       'busy',       // the approval lost to concurrent writes — certainly nothing approved
  UNCERTAIN:  'uncertain',  // no answer from the server — the approval MAY have completed
}

export const FINAL_ACCOUNT_ERROR_MESSAGES = {
  ...QUICK_ACTION_ERROR_MESSAGES,
  [FINAL_ACCOUNT_ERROR.PENDING]:    'This Final Account is still saving. Wait a moment and try again.',
  [FINAL_ACCOUNT_ERROR.MISSING]:    'This Final Account revision no longer exists. Nothing was changed.',
  [FINAL_ACCOUNT_ERROR.STALE]:      'Someone else changed this Final Account after it was loaded. Nothing was changed — review the latest version and try again.',
  [FINAL_ACCOUNT_ERROR.INVALID]:    'This Final Account cannot be written as it stands. Nothing was written.',
  [FINAL_ACCOUNT_ERROR.PERMISSION]: 'You do not have permission to do this. Nothing was changed.',
  [FINAL_ACCOUNT_ERROR.OFFLINE]:    'The server could not be reached. The Final Account must be read from the server — nothing was written. Reconnect and try again.',
  [FINAL_ACCOUNT_ERROR.UNKNOWN]:    'The Final Account could not be written. Check the revision history before trying again.',
  [FINAL_ACCOUNT_ERROR.NOT_READY]:  'The project records do not meet the Final Account requirements. Nothing was written — review the readiness checklist.',
  [FINAL_ACCOUNT_ERROR.OPEN_DRAFT]: 'A draft revision is already open. Approve or withdraw it before preparing another.',
  [FINAL_ACCOUNT_ERROR.CHANGED]:    'The project records changed after this draft was prepared. Nothing was approved — withdraw the draft and prepare a new one.',
  [FINAL_ACCOUNT_ERROR.OVERSIZED]:  'This Final Account is too large for one record. Nothing was written and nothing was truncated.',
  [FINAL_ACCOUNT_ERROR.DISABLED]:   'Final Account approval is temporarily unavailable. Nothing was changed.',
  [FINAL_ACCOUNT_ERROR.BUSY]:       'The project records were being changed while this approval ran. Nothing was approved. Try again in a moment.',
  [FINAL_ACCOUNT_ERROR.UNCERTAIN]:  'The server did not confirm this approval. It may still have completed — check whether this revision now shows as Approved. If it is still a draft, approve again: repeating the request is safe.',
}

export class FinalAccountWriteError extends QuickActionError {
  constructor(kind, message, cause, details = null) {
    super(kind, message ?? FINAL_ACCOUNT_ERROR_MESSAGES[kind] ?? FINAL_ACCOUNT_ERROR_MESSAGES[FINAL_ACCOUNT_ERROR.UNKNOWN], cause)
    this.name = 'FinalAccountWriteError'
    if (details) this.details = details
  }
}

const invalid = (reason) =>
  new FinalAccountWriteError(FINAL_ACCOUNT_ERROR.INVALID, `${FINAL_ACCOUNT_ERROR_MESSAGES[FINAL_ACCOUNT_ERROR.INVALID]} ${reason}`)

const docsOf = (snap) => snap.docs.map(d => ({ id: d.id, ...d.data() }))
const one = (snap) => (snap.exists() ? { id: snap.id, ...snap.data() } : null)

// ── Server reads ─────────────────────────────────────────────────────────────
//
// `queries` — one query per register, the SAME queries the listeners use:
//   budgetLines, purchaseOrders, progressClaims, supplierInvoices,
//   supplierCreditNotes, variations, forecastLines, supplierPayments,
//   retentionReleases, clientInvoices, clientReceipts, clientCreditNotes,
//   clientRetentionReleases, costCodes
// `refs` — baseline, pointer, and the factories header(id), snapshot(id),
// adjustments(id) for the approved-budget trio.
// Returns the `sources` object computeFinalAccount takes. Unreachable →
// OFFLINE, denied → PERMISSION; never the cache, never a partial set.
export const FINAL_ACCOUNT_QUERY_NAMES = [
  'budgetLines', 'purchaseOrders', 'progressClaims', 'supplierInvoices', 'supplierCreditNotes', 'variations',
  'forecastLines', 'supplierPayments', 'retentionReleases', 'clientInvoices', 'clientReceipts',
  'clientCreditNotes', 'clientRetentionReleases', 'costCodes',
]

export async function readFinalAccountSourcesFromServer({ queries, refs, getDocsFromServer, getDocFromServer }) {
  try {
    const lists = await Promise.all(FINAL_ACCOUNT_QUERY_NAMES.map(n => getDocsFromServer(queries[n])))
    const sources = {}
    FINAL_ACCOUNT_QUERY_NAMES.forEach((n, i) => { sources[n] = docsOf(lists[i]) })
    const [baselineSnap, pointerSnap] = await Promise.all([getDocFromServer(refs.baseline), getDocFromServer(refs.pointer)])
    sources.baseline = one(baselineSnap)
    const pointer = one(pointerSnap)
    let header = null
    let snapshot = null
    let adjustments = []
    const activeId = typeof pointer?.activeApprovalId === 'string' && pointer.activeApprovalId ? pointer.activeApprovalId : null
    if (activeId) {
      const [h, s] = await Promise.all([getDocFromServer(refs.header(activeId)), getDocFromServer(refs.snapshot(activeId))])
      header = one(h)
      snapshot = one(s)
      if (Number.isInteger(pointer.adjustmentCount) && pointer.adjustmentCount > 0) {
        adjustments = docsOf(await getDocsFromServer(refs.adjustments(activeId)))
      }
    }
    sources.approvedBudget = {
      pointer, pointerLoading: false, pointerError: false,
      header, headerLoading: false, headerError: false,
      snapshot, snapshotLoading: false, snapshotError: false,
      originalSnapshot: null, originalLoading: false, originalError: false, originalRequested: false,
      adjustments, adjustmentsLoading: false, adjustmentsError: false,
    }
    return sources
  } catch (err) {
    throw new FinalAccountWriteError(quickActionErrorKind(err?.code), undefined, err)
  }
}

// The computation over the server's copy — what PREPARE writes and what the
// page compares an approved revision against on demand.
export async function computeFinalAccountFromServer({ project, currencyCode, ...read }) {
  const sources = await readFinalAccountSourcesFromServer(read)
  return computeFinalAccount({ project, currencyCode, sources, sourceStates: settledSourceStates() })
}

async function guarded(runTransaction, db, body) {
  let outcome
  try {
    outcome = await runTransaction(db, body)
  } catch (err) {
    if (err instanceof FinalAccountWriteError) throw err
    throw new FinalAccountWriteError(quickActionErrorKind(err?.code), undefined, err)
  }
  if (outcome.kind) throw new FinalAccountWriteError(outcome.kind, undefined, undefined, outcome.details ?? null)
  return outcome
}

// ── PREPARE ──────────────────────────────────────────────────────────────────

// Returns { number, bytes }. `accountRef(n)` is the document of revision n.
export async function runFinalAccountPrepare({
  db, accountRef, accountsQuery, queries, refs, getDocsFromServer, getDocFromServer,
  project, currencyCode, input, uid, preparedByName, runTransaction, serverTimestamp,
}) {
  if (!uid) throw new FinalAccountWriteError(FINAL_ACCOUNT_ERROR.PERMISSION)
  if (typeof currencyCode !== 'string' || !/^[A-Z]{3}$/.test(currencyCode)) throw invalid('The project currency is not resolved.')

  // 1. The revision history and every register, from the server.
  let history
  try {
    history = finalAccountHistory(docsOf(await getDocsFromServer(accountsQuery)))
  } catch (err) {
    throw new FinalAccountWriteError(quickActionErrorKind(err?.code), undefined, err)
  }
  if (!history.canPrepare) throw new FinalAccountWriteError(FINAL_ACCOUNT_ERROR.OPEN_DRAFT)
  const number = history.nextNumber
  const computation = await computeFinalAccountFromServer({ project, currencyCode, queries, refs, getDocsFromServer, getDocFromServer })

  // 2. Readiness, validation, size — refuses, never truncates.
  if (!computation.ready) {
    throw new FinalAccountWriteError(FINAL_ACCOUNT_ERROR.NOT_READY, undefined, undefined, { blockers: blockerCodes(computation) })
  }
  const built = buildFinalAccountDraft({ computation, number, input, currencyCode, preparedByName })
  if (!built.ok) {
    if (built.bytes) throw new FinalAccountWriteError(FINAL_ACCOUNT_ERROR.OVERSIZED)
    throw invalid(built.error)
  }

  // 3. Create revision n — it must not exist, and n − 1 must be terminal.
  const ref = accountRef(number)
  await guarded(runTransaction, db, async (tx) => {
    const existing = await tx.get(ref)
    if (existing.exists()) return { kind: FINAL_ACCOUNT_ERROR.OPEN_DRAFT }
    if (number > 1) {
      const previous = await tx.get(accountRef(number - 1))
      if (!previous.exists()) return { kind: FINAL_ACCOUNT_ERROR.STALE }
      if (previous.data().status === FINAL_ACCOUNT_STATUS.DRAFT) return { kind: FINAL_ACCOUNT_ERROR.OPEN_DRAFT }
    }
    tx.set(ref, {
      ...built.payload,
      status: FINAL_ACCOUNT_STATUS.DRAFT,
      revision: 1,
      approvedAt: null, approvedBy: null, approvedByName: null, approvedByRole: null, selfApproved: null, sourcesReadAt: null,
      withdrawnAt: null, withdrawnBy: null, withdrawReason: '',
      createdAt: serverTimestamp(), createdBy: uid,
      updatedAt: serverTimestamp(), updatedBy: uid,
    })
    return { kind: null }
  })
  return { number, bytes: built.bytes }
}

// ── WITHDRAW ─────────────────────────────────────────────────────────────────

export async function runFinalAccountWithdraw({ db, accountRef, seen, reason, uid, runTransaction, serverTimestamp }) {
  if (!uid) throw new FinalAccountWriteError(FINAL_ACCOUNT_ERROR.PERMISSION)
  if (!seen?.updatedAt) throw new FinalAccountWriteError(FINAL_ACCOUNT_ERROR.PENDING)
  const reasonError = validateFinalAccountWithdrawReason(reason)
  if (reasonError) throw invalid(reasonError)

  const outcome = await guarded(runTransaction, db, async (tx) => {
    const snap = await tx.get(accountRef)
    if (!snap.exists()) return { kind: FINAL_ACCOUNT_ERROR.MISSING }
    const current = snap.data()
    if (current.status !== FINAL_ACCOUNT_STATUS.DRAFT || !sameActivityVersion(seen, current)) return { kind: FINAL_ACCOUNT_ERROR.STALE }
    const revision = activityRevision(current) + 1
    tx.update(accountRef, {
      status: FINAL_ACCOUNT_STATUS.WITHDRAWN,
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

// ── APPROVE (through the trusted callable) ───────────────────────────────────

// The callable's `details.code` (functions/src/lib/errors.js) → an error kind.
const CALLABLE_KIND = {
  'unauthenticated':               FINAL_ACCOUNT_ERROR.PERMISSION,
  'no-membership':                 FINAL_ACCOUNT_ERROR.PERMISSION,
  'membership-inactive':           FINAL_ACCOUNT_ERROR.PERMISSION,
  'not-approver':                  FINAL_ACCOUNT_ERROR.PERMISSION,
  'invalid-argument':              FINAL_ACCOUNT_ERROR.INVALID,
  'not-found':                     FINAL_ACCOUNT_ERROR.MISSING,
  'final-account-not-draft':       FINAL_ACCOUNT_ERROR.STALE,
  'final-account-stale':           FINAL_ACCOUNT_ERROR.STALE,
  'final-account-not-ready':       FINAL_ACCOUNT_ERROR.NOT_READY,
  'final-account-figures-changed': FINAL_ACCOUNT_ERROR.CHANGED,
  'final-account-too-large':       FINAL_ACCOUNT_ERROR.OVERSIZED,
  'final-account-disabled':        FINAL_ACCOUNT_ERROR.DISABLED,
  'final-account-busy':            FINAL_ACCOUNT_ERROR.BUSY,
}

export function finalAccountCallableErrorKind(err) {
  const detail = err?.details?.code
  if (detail && CALLABLE_KIND[detail]) return CALLABLE_KIND[detail]
  const code = String(err?.code ?? '').replace(/^functions\//, '')
  if (code === 'permission-denied' || code === 'unauthenticated') return FINAL_ACCOUNT_ERROR.PERMISSION
  // No typed answer: a timeout, a dropped connection or an internal error.
  // The request may have reached the server and the approval may have
  // committed — never report "nothing was written" here.
  return FINAL_ACCOUNT_ERROR.UNCERTAIN
}

// The browser waits LONGER than the function may run (120 s, functions/src/
// index.js → FINAL_ACCOUNT_CALL_OPTIONS), so the server's own answer — success
// or a typed refusal — arrives before the client gives up. The SDK default is
// 70 s, which would abandon an approval the server is still completing.
export const APPROVE_CALL_TIMEOUT_MS = 130000

// `call(data)` invokes approveFinalAccount and resolves to its result. The
// request names the project, the revision and the copy the reviewer saw —
// NEVER an amount. A lost response is safe to retry: the callable answers an
// already-approved revision by the same caller without writing again.
export async function runFinalAccountApprove({ call, projectId, seen, acknowledged }) {
  if (!seen?.updatedAt) throw new FinalAccountWriteError(FINAL_ACCOUNT_ERROR.PENDING)
  if (seen.status !== FINAL_ACCOUNT_STATUS.DRAFT) throw new FinalAccountWriteError(FINAL_ACCOUNT_ERROR.STALE)
  if (acknowledged !== true) throw invalid('Acknowledge the outstanding balances before approving.')
  try {
    return await call({ projectId, number: seen.number, expectedRevision: activityRevision(seen), acknowledged: true })
  } catch (err) {
    const kind = finalAccountCallableErrorKind(err)
    throw new FinalAccountWriteError(kind, undefined, err, err?.details?.blockers ? { blockers: err.details.blockers } : null)
  }
}
