import {
  ACTIVITY_STATUS, normaliseActivityDraft, validateActivityDraft, validateCancelReason,
  sameActivityVersion, activityRevision,
  QUICK_ACTION_ERROR, QUICK_ACTION_ERROR_MESSAGES, quickActionErrorKind,
} from './projectTimeline'
import { QuickActionError } from './activityQuickActions'
import { newPredecessorIds, predecessorsOf } from './ganttDependencies'

// ── Guarded activity writes — create, full edit, cancel (ADR-65) ─────────────
//
// The full editor and the cancel dialog used to be unconditioned `updateDoc`
// calls: last-write-wins (Deferred Control 23). From 1A2 every activity write
// is ONE Firestore transaction with the same compare-and-set the quick actions
// already had (lib/activityQuickActions.js), plus the revision contract the
// rules now require:
//
//   1. read the target activity INSIDE the transaction (the server copy)
//   2. refuse if it no longer exists
//   3. refuse if its `revision` or its (updatedAt, updatedBy) pair differs
//      from the copy the dialog was opened from — someone wrote in between
//   4. re-validate the MERGED document (the server copy under the user's
//      edits) with the same validator the rules mirror
//   5. for every predecessor the edit ADDS, read the source activity in the
//      same transaction: it must exist in this project and not be cancelled
//      (server-current, never from the listener alone)
//   6. ALL reads before the write; then write the edited fields with
//      `revision` = stored + 1 and the two server stamps — exactly once
//
// If the document changes between read and commit, Firestore aborts and
// re-runs the callback; the re-run re-reads, step 3 fails, and the save is
// REFUSED — never silently re-applied over the other person's edit.
//
// ⚠️ WHAT THIS DOES NOT DO (Deferred Control 41). It reads the successor and
// the NEW predecessors — never the whole graph — so a cycle can still be
// closed by two concurrent edits that each look acyclic against their own
// snapshot; `findCycleMembers` reports it on the next listener update and
// the chart flags every member for review. A predecessor cancelled after the
// read-and-check races the same way. And while the Stage-1 transitional
// ruleset is published an un-reloaded 1A1 browser may write WITHOUT
// incrementing the revision; the stamp comparison (step 3) still catches
// that for the next save here, but no rule prevents it until FINAL.
//
// The callback has NO side effects beyond the transaction: it returns an
// outcome, and the caller (the hook → the dialog) reacts after it settles.
// On any refusal nothing is written and the dialog keeps the user's draft.
//
// Firestore SDK functions are INJECTED (`runTransaction`, `serverTimestamp`,
// `docRef`) so this module imports no Firebase code; the emulator suite
// passes the test SDK and exercises the real transaction.

export const ACTIVITY_WRITE_ERROR = QUICK_ACTION_ERROR
export const ACTIVITY_WRITE_ERROR_MESSAGES = {
  ...QUICK_ACTION_ERROR_MESSAGES,
  [QUICK_ACTION_ERROR.STALE]:
    'Someone else changed this activity after you opened it. Nothing was saved — your edits are still here. Reload the latest version, check it, and save again.',
  [QUICK_ACTION_ERROR.OFFLINE]:
    'You appear to be offline. Nothing was saved — your edits are still here. Reconnect and try again.',
  [QUICK_ACTION_ERROR.UNKNOWN]:
    'The activity could not be saved. Nothing was written — your edits are still here.',
}

export class ActivityWriteError extends QuickActionError {
  constructor(kind, message, cause) {
    super(kind, message ?? ACTIVITY_WRITE_ERROR_MESSAGES[kind] ?? ACTIVITY_WRITE_ERROR_MESSAGES[QUICK_ACTION_ERROR.UNKNOWN], cause)
    this.name = 'ActivityWriteError'
  }
}

async function guarded(runTransaction, db, body) {
  let outcome
  try {
    outcome = await runTransaction(db, body)
  } catch (err) {
    throw new ActivityWriteError(quickActionErrorKind(err?.code), undefined, err)
  }
  if (outcome.kind) throw new ActivityWriteError(outcome.kind, outcome.reason ? `${ACTIVITY_WRITE_ERROR_MESSAGES[outcome.kind]} ${outcome.reason}` : undefined)
  return outcome
}

// Reads every NEW predecessor on the server. Returns the first problem as a
// user sentence, or null. `predecessorRef(id)` resolves a sibling activity in
// the SAME project — the only path the hook can build — so an id from another
// project simply does not exist here.
async function checkNewPredecessors(tx, predecessorRef, ids, selfId) {
  for (const id of ids) {
    if (id === selfId) return 'An activity cannot depend on itself.'
    const snap = await tx.get(predecessorRef(id))
    if (!snap.exists()) return 'A predecessor is not in this project\'s programme.'
    if (snap.data()?.status === ACTIVITY_STATUS.CANCELLED) return 'A cancelled activity cannot be a predecessor.'
  }
  return null
}

// CREATE — revision 1, cancellation stamps empty, predecessors (if any)
// verified on the server before the set. Returns the new document's id.
export async function runActivityCreate({
  db, ref, predecessorRef, input, uid, runTransaction, serverTimestamp,
}) {
  if (!uid) throw new ActivityWriteError(QUICK_ACTION_ERROR.PERMISSION)
  const validationError = validateActivityDraft(input, { creating: true })
  if (validationError) throw new ActivityWriteError(QUICK_ACTION_ERROR.INVALID, `${ACTIVITY_WRITE_ERROR_MESSAGES[QUICK_ACTION_ERROR.INVALID]} ${validationError}`)
  const fields = normaliseActivityDraft(input)
  const newIds = newPredecessorIds(fields.predecessors, [])

  await guarded(runTransaction, db, async (tx) => {
    const problem = await checkNewPredecessors(tx, predecessorRef, newIds, ref.id)
    if (problem) return { kind: QUICK_ACTION_ERROR.INVALID, reason: problem }
    tx.set(ref, {
      ...fields,
      cancelReason: '',
      cancelledAt:  null,
      cancelledBy:  null,
      revision: 1,
      createdAt: serverTimestamp(),
      createdBy: uid,
      updatedAt: serverTimestamp(),
      updatedBy: uid,
    })
    return { kind: null }
  })
  return ref.id
}

// FULL EDIT — compare-and-set on the server copy; writes the normalised
// fields + revision + stamps. `seen` is the activity the dialog was opened
// from (its revision and stamps are the version check).
export async function runActivityUpdate({
  db, ref, predecessorRef, seen, input, uid, runTransaction, serverTimestamp,
}) {
  if (!uid) throw new ActivityWriteError(QUICK_ACTION_ERROR.PERMISSION)
  if (!seen?.updatedAt) throw new ActivityWriteError(QUICK_ACTION_ERROR.PENDING)
  const validationError = validateActivityDraft(input)
  if (validationError) throw new ActivityWriteError(QUICK_ACTION_ERROR.INVALID, `${ACTIVITY_WRITE_ERROR_MESSAGES[QUICK_ACTION_ERROR.INVALID]} ${validationError}`)
  const fields = normaliseActivityDraft(input)

  const outcome = await guarded(runTransaction, db, async (tx) => {
    const snap = await tx.get(ref)
    if (!snap.exists()) return { kind: QUICK_ACTION_ERROR.MISSING }
    const current = { id: snap.id, ...snap.data() }
    if (!sameActivityVersion(seen, current)) return { kind: QUICK_ACTION_ERROR.STALE }
    if (current.status === ACTIVITY_STATUS.CANCELLED) {
      return { kind: QUICK_ACTION_ERROR.INVALID, reason: 'A cancelled activity cannot be edited.' }
    }
    // The merged document must satisfy every invariant (the rules mirror).
    const mergedError = validateActivityDraft({ ...current, ...fields })
    if (mergedError) return { kind: QUICK_ACTION_ERROR.INVALID, reason: mergedError }
    // Server-current source check for the links this edit ADDS (reads before
    // the write). Retained links are left as they are, for review.
    const previousIds = predecessorsOf(current).map(e => e?.activityId).filter(Boolean)
    const problem = await checkNewPredecessors(tx, predecessorRef, newPredecessorIds(fields.predecessors, previousIds), current.id)
    if (problem) return { kind: QUICK_ACTION_ERROR.INVALID, reason: problem }

    const revision = activityRevision(current) + 1
    tx.update(ref, {
      ...fields,
      revision,
      updatedAt: serverTimestamp(),
      updatedBy: uid,
    })
    return { kind: null, revision }
  })
  return outcome.revision
}

// CANCEL — the terminal branch: status + reason + stamps + revision only.
export async function runActivityCancel({
  db, ref, seen, reason, uid, runTransaction, serverTimestamp,
}) {
  if (!uid) throw new ActivityWriteError(QUICK_ACTION_ERROR.PERMISSION)
  if (!seen?.updatedAt) throw new ActivityWriteError(QUICK_ACTION_ERROR.PENDING)
  const reasonError = validateCancelReason(reason)
  if (reasonError) throw new ActivityWriteError(QUICK_ACTION_ERROR.INVALID, `${ACTIVITY_WRITE_ERROR_MESSAGES[QUICK_ACTION_ERROR.INVALID]} ${reasonError}`)

  const outcome = await guarded(runTransaction, db, async (tx) => {
    const snap = await tx.get(ref)
    if (!snap.exists()) return { kind: QUICK_ACTION_ERROR.MISSING }
    const current = { id: snap.id, ...snap.data() }
    if (!sameActivityVersion(seen, current)) return { kind: QUICK_ACTION_ERROR.STALE }
    if (current.status === ACTIVITY_STATUS.CANCELLED) {
      return { kind: QUICK_ACTION_ERROR.INVALID, reason: 'This activity is already cancelled.' }
    }
    const revision = activityRevision(current) + 1
    tx.update(ref, {
      status:       ACTIVITY_STATUS.CANCELLED,
      cancelReason: String(reason).trim(),
      cancelledAt:  serverTimestamp(),
      cancelledBy:  uid,
      revision,
      updatedAt:    serverTimestamp(),
      updatedBy:    uid,
    })
    return { kind: null, revision }
  })
  return outcome.revision
}
