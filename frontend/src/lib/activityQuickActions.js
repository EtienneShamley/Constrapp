import {
  planQuickAction, sameActivityVersion, activityRevision,
  QUICK_ACTION_ERROR, QUICK_ACTION_ERROR_MESSAGES, quickActionErrorKind,
} from './projectTimeline'

// ── Guarded quick status actions (Timeline) ──────────────────────────────────
//
// Runs ONE quick status action as a Firestore transaction that refuses to
// write over a change the user has not seen:
//
//   1. read the activity INSIDE the transaction (the server copy)
//   2. refuse if it no longer exists
//   3. refuse if its (updatedAt, updatedBy) differs from the copy the button
//      was rendered from — someone wrote in between
//   4. re-plan the transition against the server copy (planQuickAction), so a
//      transition that is no longer valid is refused, never forced
//   5. write ONLY the planned keys plus the two audit stamps
//
// If the document changes between the read and the commit, Firestore aborts
// and re-runs the callback; the re-run re-reads, step 3 now fails, and the
// action is REFUSED — it is never silently re-applied to a changed activity.
//
// The callback has NO side effects beyond the transaction: it returns an
// outcome, and the caller (the hook → the page) reacts to the result after the
// transaction settles.
//
// ⚠️ SCOPE OF THE GUARANTEE (ADR-65). Every activity write — this quick action,
// the full editor and the cancel dialog (lib/activityActions.js) — now runs
// the same compare-and-set: refuse when the server copy's `revision` or
// `(updatedAt, updatedBy)` differs from what the user saw, write `revision`
// = stored + 1. The FINAL ruleset requires the increment, so a blind write
// that does not know the current revision is refused by the RULES; during the
// Stage-1 transitional ruleset an un-reloaded 1A1 browser may still write
// without incrementing, which the stamp comparison detects afterwards but no
// rule prevents (docs/SECURITY.md → Deferred Control 41).
//
// Firestore SDK functions are INJECTED (`runTransaction`, `serverTimestamp`)
// so this module imports no Firebase code: the hook passes the app SDK, and
// the emulator suite passes the test SDK and exercises the real transaction.

export class QuickActionError extends Error {
  constructor(kind, message, cause) {
    super(message ?? QUICK_ACTION_ERROR_MESSAGES[kind] ?? QUICK_ACTION_ERROR_MESSAGES[QUICK_ACTION_ERROR.UNKNOWN])
    this.name = 'QuickActionError'
    this.kind = kind
    // The underlying Firestore error, if any — for diagnosis, never shown raw.
    if (cause) this.cause = cause
  }
}

export async function runActivityQuickAction({
  db, ref, seen, action, uid, now = new Date(),
  runTransaction, serverTimestamp,
}) {
  if (!uid) throw new QuickActionError(QUICK_ACTION_ERROR.PERMISSION)
  // A locally-pending write has no server time yet, so "unchanged since I saw
  // it" cannot be established. Refuse rather than guess.
  if (!seen?.updatedAt) throw new QuickActionError(QUICK_ACTION_ERROR.PENDING)

  let outcome
  try {
    outcome = await runTransaction(db, async (tx) => {
      const snap = await tx.get(ref)
      if (!snap.exists()) return { kind: QUICK_ACTION_ERROR.MISSING }
      const current = { id: snap.id, ...snap.data() }
      if (!sameActivityVersion(seen, current)) return { kind: QUICK_ACTION_ERROR.STALE }
      const plan = planQuickAction(current, action, now)
      if (!plan.ok) return { kind: QUICK_ACTION_ERROR.INVALID, reason: plan.reason }
      // ADR-65: exactly one increment, from the SERVER copy's revision.
      const revision = activityRevision(current) + 1
      tx.update(ref, {
        ...plan.changes,
        revision,
        updatedAt: serverTimestamp(),
        updatedBy: uid,
      })
      return { kind: null, changes: { ...plan.changes, revision } }
    })
  } catch (err) {
    throw new QuickActionError(quickActionErrorKind(err?.code), undefined, err)
  }

  if (outcome.kind) {
    throw new QuickActionError(
      outcome.kind,
      outcome.kind === QUICK_ACTION_ERROR.INVALID && outcome.reason
        ? `${QUICK_ACTION_ERROR_MESSAGES[QUICK_ACTION_ERROR.INVALID]} ${outcome.reason}`
        : undefined,
    )
  }
  return outcome.changes
}
