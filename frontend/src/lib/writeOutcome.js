// ── Write outcome: confirmed, failed or uncertain (L3 Stage 2) ───────────────
//
// One reusable description of what happened to a Firestore write, for the
// dialogs that used to `await` a write and show `err.message`.
//
// WHY IT EXISTS. Measured against the real Web SDK with an unreachable backend:
//   · a plain write (addDoc / setDoc / updateDoc) NEVER settles — the SDK
//     queues it and sends it when the connection returns, so `await` hangs and
//     a "Saving…" button stays disabled for ever;
//   · a transaction rejects with `unavailable` after a few seconds;
//   · either can be accepted by the server while the reply is lost.
// So a write has THREE honest outcomes, not two:
//
//   CONFIRMED  the server acknowledged it
//   FAILED     the server (or a local check) refused it — nothing was written,
//              and the same action may be tried again
//   UNCERTAIN  no answer, or an answer that does not say whether it committed
//
// RULES THIS MODULE KEEPS.
//   · It never retries anything. A second attempt at a create is a second
//     document; only a person who has looked at the register may ask for one.
//   · It never reports success before the write's own promise resolves.
//   · Its time limit is a limit on WAITING, not on the write: a timer cannot
//     cancel a Firestore operation, so after the limit the write is still in
//     flight and its eventual result is still reported.
//   · While a write is in flight, or its outcome is uncertain, a second
//     submission from the same dialog is refused.
//
// No Firebase and no React in this file: the controller is driven by an
// injected operation and injected timers, so the unit suite exercises every
// path with no emulator. `hooks/useWriteAction.jsx` is the thin React binding.

export const WRITE_PHASE = {
  IDLE:        'idle',
  SAVING:      'saving',       // in flight, inside the waiting limit
  UNCONFIRMED: 'unconfirmed',  // in flight, past the waiting limit
  FAILED:      'failed',       // settled: definitely not written
  UNCERTAIN:   'uncertain',    // settled: cannot tell whether it was written
}

export const WRITE_FAILURE = {
  PERMISSION:  'permission',
  SIGNED_OUT:  'signed-out',
  MISSING:     'missing',
  CONFLICT:    'conflict',
  REJECTED:    'rejected',
  QUOTA:       'quota',
  UNREACHABLE: 'unreachable',
  NO_ANSWER:   'no-answer',
  LOCAL:       'local',
  BLOCKED:     'blocked',
}

// How long a dialog shows "Saving…" before it stops waiting. Long enough for a
// slow mobile connection and for a transaction's own retries to give up first
// (about nine seconds when the backend is unreachable).
export const WRITE_CONFIRM_TIMEOUT_MS = 15000

// Firestore status codes that mean the write was REFUSED: it did not commit.
const DEFINITE = {
  'permission-denied':   [WRITE_FAILURE.PERMISSION, 'You do not have permission to do this. Nothing was saved.'],
  'unauthenticated':     [WRITE_FAILURE.SIGNED_OUT, 'Your session has ended. Nothing was saved — sign in again and retry.'],
  'not-found':           [WRITE_FAILURE.MISSING,    'This record no longer exists. Nothing was saved — reload the page.'],
  'already-exists':      [WRITE_FAILURE.CONFLICT,   'A record with this identity already exists. Nothing was saved — reload the page.'],
  'aborted':             [WRITE_FAILURE.CONFLICT,   'Someone else changed this at the same time. Nothing was saved — reload the page, review it and retry.'],
  'failed-precondition': [WRITE_FAILURE.CONFLICT,   'This record changed since you loaded it. Nothing was saved — reload the page, review it and retry.'],
  'invalid-argument':    [WRITE_FAILURE.REJECTED,   'The server rejected these details. Nothing was saved.'],
  'out-of-range':        [WRITE_FAILURE.REJECTED,   'The server rejected these details. Nothing was saved.'],
  'unimplemented':       [WRITE_FAILURE.REJECTED,   'The server does not support this action. Nothing was saved.'],
  'resource-exhausted':  [WRITE_FAILURE.QUOTA,      'The service is over its limit at the moment. Nothing was saved — try again shortly.'],
}

// Codes that do NOT say whether the write committed. `unavailable` is what a
// transaction reports when the backend cannot be reached — usually before
// anything was sent, but a commit whose reply was lost looks the same.
const AMBIGUOUS = {
  'unavailable':       WRITE_FAILURE.UNREACHABLE,
  'deadline-exceeded': WRITE_FAILURE.NO_ANSWER,
  'cancelled':         WRITE_FAILURE.NO_ANSWER,
  'internal':          WRITE_FAILURE.NO_ANSWER,
  'unknown':           WRITE_FAILURE.NO_ANSWER,
  'data-loss':         WRITE_FAILURE.NO_ANSWER,
}

export const WRITE_MESSAGES = {
  unreachable:
    'Could not reach the server, so this was not confirmed as saved. It was most likely not saved. ' +
    'Check your connection, then check the list before trying again.',
  noAnswer:
    'The server did not say whether this was saved. Do not enter it again yet — ' +
    'check the list (reload the page if needed) first.',
  unconfirmed:
    'Still waiting for the server to confirm this. It has not failed and may yet be saved, so do not enter it again. ' +
    'Keep this tab open — this message updates when the server answers. If you close this, the result is shown at the top of the page.',
  local: 'This could not be completed. Nothing was saved.',
  blocked:
    'An earlier attempt at this has not been confirmed by the server — see the notice at the top of the page. ' +
    'This new attempt was not sent. Wait for that notice to resolve, or check the list and clear it, before trying again.',
}

const firestoreCode = (err) => {
  for (const c of [err?.code, err?.cause?.code]) {
    if (typeof c !== 'string') continue
    const code = c.replace(/^firestore\//, '')
    if (code in DEFINITE || code in AMBIGUOUS) return code
  }
  return null
}

// Turn anything a write threw into { certain, kind, message }.
//
//   · a known Firestore code            → the mapped message (never the SDK's own text)
//   · any other FirebaseError           → uncertain: we cannot vouch for a code we do not know
//   · a plain Error with no known code  → the hook's own validation or lifecycle
//     refusal ("Only draft receipts can be edited"), thrown BEFORE any write —
//     definite, and its message is already written for the user
export function describeWriteError(err) {
  // A trusted-callable failure (ADR-90 / ADR-93 / ADR-94) has already been
  // classified by its action module: a typed refusal is CERTAIN with the
  // server's own reason; an untyped transport failure is UNCERTAIN — the
  // operation may have committed — and must never be reported as refused.
  if ((err?.name === 'SupplierFinanceError' || err?.name === 'VariationWriteError' || err?.name === 'EstimateError') && typeof err?.kind === 'string') {
    if (err.kind === 'uncertain') return { certain: false, kind: WRITE_FAILURE.NO_ANSWER, message: err.message || WRITE_MESSAGES.noAnswer }
    return { certain: true, kind: WRITE_FAILURE.REJECTED, message: err.message }
  }
  const code = firestoreCode(err)
  if (code && code in DEFINITE) {
    const [kind, message] = DEFINITE[code]
    // A domain error that WRAPS a definite Firestore failure (the *Actions
    // modules) carries a better message than the generic one.
    const own = err?.name !== 'FirebaseError' && typeof err?.message === 'string' && err.message.trim()
    return { certain: true, kind, message: own || message }
  }
  if (code) {
    const kind = AMBIGUOUS[code]
    return {
      certain: false,
      kind,
      message: kind === WRITE_FAILURE.UNREACHABLE ? WRITE_MESSAGES.unreachable : WRITE_MESSAGES.noAnswer,
    }
  }
  if (err?.name === 'FirebaseError') {
    return { certain: false, kind: WRITE_FAILURE.NO_ANSWER, message: WRITE_MESSAGES.noAnswer }
  }
  const message = typeof err?.message === 'string' && err.message.trim() ? err.message.trim() : WRITE_MESSAGES.local
  return { certain: true, kind: WRITE_FAILURE.LOCAL, message }
}

// ── Writes whose dialog has gone ─────────────────────────────────────────────
//
// A dialog may be closed while its write is still unanswered. The controller
// then hands the write to this tracker, and `components/UnconfirmedWrites.jsx`
// (mounted once in the app shell) reports the eventual outcome. In-memory only:
// a reload clears it, and a queued write does not survive a reload either.

export const TRACKED_STATUS = {
  PENDING:   'pending',
  CONFIRMED: 'confirmed',
  FAILED:    'failed',
  UNCERTAIN: 'uncertain',
}

export function createWriteTracker() {
  let entries = []
  let seq = 0
  const listeners = new Set()
  const publish = (next) => { entries = next; listeners.forEach((l) => l()) }
  return {
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    getSnapshot: () => entries,
    add({ label, startedAt, status = TRACKED_STATUS.PENDING, message = null }) {
      seq += 1
      const id = `w${seq}`
      publish([...entries, { id, label, startedAt, status, message }])
      return id
    },
    // True while a write of this kind is unanswered, or ended uncertain and
    // has not been cleared by the user. A NEW dialog of the same kind asks
    // this before sending anything, so closing and reopening a dialog cannot
    // get round the guard its predecessor held.
    blocks(label) {
      return entries.some((e) => e.label === label &&
        (e.status === TRACKED_STATUS.PENDING || e.status === TRACKED_STATUS.UNCERTAIN))
    },
    settle(id, status, message = null) {
      publish(entries.map((e) => (e.id === id ? { ...e, status, message } : e)))
    },
    // A write still in flight cannot be dismissed: it is the only thing
    // telling the user not to enter the record again.
    dismiss(id) {
      publish(entries.filter((e) => e.id !== id || e.status === TRACKED_STATUS.PENDING))
    },
    remove(id) { publish(entries.filter((e) => e.id !== id)) },
  }
}

export const writeTracker = createWriteTracker()

// ── The controller ───────────────────────────────────────────────────────────

const IDLE = Object.freeze({ phase: WRITE_PHASE.IDLE, kind: null, message: null })

// `label` names the record for the page-level notice ("Client receipt").
// `run(operation, { onConfirmed })` starts ONE write:
//   · returns false, and does not call the operation, when a write is already
//     in flight, the last outcome is uncertain and unacknowledged, or an
//     earlier dialog with the same label left one unanswered or uncertain;
//   · `operation` is called exactly once and never again by this module;
//   · `onConfirmed(value)` runs only when the operation's promise RESOLVES and
//     the dialog is still attached.
export function createWriteController({
  label = 'Change',
  timeoutMs = WRITE_CONFIRM_TIMEOUT_MS,
  tracker = writeTracker,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (t) => clearTimeout(t),
  now = () => Date.now(),
} = {}) {
  let state = IDLE
  let attached = true
  let inFlight = false
  let startedAt = null
  let trackedId = null
  const listeners = new Set()
  const set = (next) => { state = next; listeners.forEach((l) => l()) }

  const settle = (status, described, onConfirmed, value) => {
    inFlight = false
    if (!attached) {
      // The dialog has gone: the page-level notice carries the result.
      if (trackedId) tracker.settle(trackedId, status, described?.message ?? null)
      trackedId = null
      state = IDLE
      return
    }
    if (status === TRACKED_STATUS.CONFIRMED) {
      set(IDLE)
      onConfirmed?.(value)
    } else if (status === TRACKED_STATUS.FAILED) {
      set({ phase: WRITE_PHASE.FAILED, kind: described.kind, message: described.message })
    } else {
      set({ phase: WRITE_PHASE.UNCERTAIN, kind: described.kind, message: described.message })
    }
  }

  return {
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    getState: () => state,

    run(operation, { onConfirmed } = {}) {
      if (inFlight || state.phase === WRITE_PHASE.UNCERTAIN) return false
      // An earlier dialog of this kind left a write unanswered or uncertain.
      // Refuse WITHOUT calling the operation: nothing is sent.
      if (tracker.blocks(label)) {
        set({ phase: WRITE_PHASE.FAILED, kind: WRITE_FAILURE.BLOCKED, message: WRITE_MESSAGES.blocked })
        return false
      }
      inFlight = true
      startedAt = now()
      set({ phase: WRITE_PHASE.SAVING, kind: null, message: null })

      let promise
      try {
        promise = Promise.resolve(operation())
      } catch (err) {
        promise = Promise.reject(err)
      }

      const timer = setTimer(() => {
        if (!inFlight || !attached) return
        set({ phase: WRITE_PHASE.UNCONFIRMED, kind: WRITE_FAILURE.NO_ANSWER, message: WRITE_MESSAGES.unconfirmed })
      }, timeoutMs)

      promise.then(
        (value) => {
          clearTimer(timer)
          settle(TRACKED_STATUS.CONFIRMED, null, onConfirmed, value)
        },
        (err) => {
          clearTimer(timer)
          const described = describeWriteError(err)
          settle(described.certain ? TRACKED_STATUS.FAILED : TRACKED_STATUS.UNCERTAIN, described)
        },
      )
      return true
    },

    // The user states they have checked and the record was not saved. This is
    // the ONLY way out of an uncertain outcome, and it is refused while the
    // write is still in flight — a retry then would certainly duplicate it.
    acknowledge() {
      if (inFlight || state.phase !== WRITE_PHASE.UNCERTAIN) return false
      set(IDLE)
      return true
    },

    // Clear a definite failure (for example when the user edits the form).
    clearFailure() {
      if (state.phase === WRITE_PHASE.FAILED) set(IDLE)
    },

    attach() {
      attached = true
      if (trackedId) { tracker.remove(trackedId); trackedId = null }
    },

    // The dialog unmounted. A write still in flight is handed to the tracker,
    // and so is a settled UNCERTAIN outcome the user never acknowledged —
    // otherwise closing the dialog would silently discard the guard.
    detach() {
      attached = false
      if (trackedId) return
      if (inFlight) {
        trackedId = tracker.add({ label, startedAt })
      } else if (state.phase === WRITE_PHASE.UNCERTAIN) {
        trackedId = tracker.add({ label, startedAt, status: TRACKED_STATUS.UNCERTAIN, message: state.message })
      }
    },
  }
}

// Derived flags for a dialog's buttons.
//   busy    show the "Saving…" wording and keep Cancel disabled
//   locked  the submit control must be disabled
export function writeFlags(state) {
  const phase = state?.phase ?? WRITE_PHASE.IDLE
  return {
    busy:    phase === WRITE_PHASE.SAVING,
    waiting: phase === WRITE_PHASE.UNCONFIRMED,
    locked:  phase === WRITE_PHASE.SAVING || phase === WRITE_PHASE.UNCONFIRMED || phase === WRITE_PHASE.UNCERTAIN,
    canAcknowledge: phase === WRITE_PHASE.UNCERTAIN,
  }
}
