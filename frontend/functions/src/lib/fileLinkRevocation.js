import { FieldPath, FieldValue, Timestamp } from './firebaseAdmin.js'
import { AUDIT, auditInTx } from './audit.js'
import { companyRef } from './companyLock.js'
import { isInternalRole, isValidId } from './validation.js'
import { toIso, toMillis } from './membershipState.js'
import { sweepPage } from './fileLinkTokens.js'

// ── Legacy file-link revocation — durable state machine (ADR-74, DC46-B) ─────
//
// WHAT THIS IS FOR. When a person loses access to a company's files, any
// Firebase download URL they copied earlier must stop working. Membership
// itself is revoked at once by the membership transaction (Storage Rules read
// `users/{uid}` on every request). This module does the SLOWER, separate job:
// removing the download tokens from the company's objects, in the background.
//
// ⚠️ NOTHING HERE IS IMMEDIATE. Old links keep working until a sweep that
// STARTED AFTER the member's change has finished with ZERO failures. The
// status below says exactly that and never rounds up.
//
// THE CORRECTNESS RULE. Each request gets a sequence number, assigned INSIDE
// the membership transaction on the state document. A sweep records the
// request sequence it started at, in a transaction on the SAME document — so
// Firestore serialises the two, and a sweep at sequence N provably began after
// every membership change numbered ≤ N committed. From that moment those
// people are denied every read, so they cannot learn any token minted later.
// A member is therefore shown as revoked only when `completedSeq ≥ their seq`.
// Clocks are never compared for this.
//
// DOCUMENTS (Admin SDK only — no rules block exists for either, so every
// browser read and write is denied by default):
//   companies/{c}/system/fileLinkRevocation          — the state, kept forever
//   companies/{c}/fileLinkRevocationQueue/pending    — exists ONLY while work
//       is outstanding; the worker finds work with one unfiltered
//       collection-group query, which needs no index.
//
// No token value is ever written to Firestore, the audit trail or a log.
//
// ── ADR-75 (DC46-C, Stage 1) — periodic reconciliation ──────────────────────
//
// The SAME queue and the SAME sweep also run on a timer. When reconciliation
// is switched on (FILE_LINK_RECONCILE_INTERVAL_HOURS > 0) the worker PLANS:
// it walks `companies`, and for every company whose last SUCCESSFUL sweep
// STARTED at least one interval ago it writes an ordinary revocation request
// with priority `periodic`. Nothing else is new on the Storage side.
//
//   · ELIGIBILITY LIVES ON THE COMPANY (`completedPassStartedAt`, written only
//     by a zero-failure finish). The planning cursor is an optimisation: losing
//     or corrupting it repeats work and can never skip a company.
//   · URGENT BEFORE ROUTINE. Membership and operator requests are `urgent`;
//     they are always served first, and they pre-empt a periodic sweep of the
//     same company. Routine work gets a small reserved share of each run so it
//     cannot starve.
//   · A SLICE IS NOT A FAILURE. A company that yields at a page boundary to
//     let another take its turn keeps its checkpoint and is not penalised.
//
// ⚠️ The interval bounds nothing absolutely. A token lives until the next
// successful sweep of its company, which is the interval PLUS planning, queue
// and sweep time — longer if a sweep is incomplete. Never call it a guarantee.
//
//   system/fileLinkReconciliation   — the planning cursor (Admin SDK only; no
//       rules block matches it). Never read or written while the interval is 0.

export const QUEUE_COLLECTION = 'fileLinkRevocationQueue'
export const MARKER_ID = 'pending'
export const stateRef = (db, companyId) => companyRef(db, companyId).collection('system').doc('fileLinkRevocation')
export const markerRef = (db, companyId) => companyRef(db, companyId).collection(QUEUE_COLLECTION).doc(MARKER_ID)

export const REASON = { DEACTIVATED: 'member.deactivated', ROLE_REDUCED: 'member.role_reduced', OPERATOR: 'operator', PERIODIC: 'periodic' }

// ADR-75. A marker or state written before Stage 1 carries no priority and is
// URGENT — the only kind of request that existed then.
export const PRIORITY = { URGENT: 'urgent', PERIODIC: 'periodic' }
export const priorityOf = (v) => (v === PRIORITY.PERIODIC ? PRIORITY.PERIODIC : PRIORITY.URGENT)

export const CURSOR_COLLECTION = 'system'
export const CURSOR_ID = 'fileLinkReconciliation'
export const cursorRef = (db) => db.collection(CURSOR_COLLECTION).doc(CURSOR_ID)

export const LEASE_MS = 6 * 60 * 1000
export const WORK_BUDGET_MS = 4 * 60 * 1000
export const DELAY_AFTER_MS = 15 * 60 * 1000
export const LEGACY_MARGIN_MS = 10 * 60 * 1000
export const MAX_BACKOFF_MS = 60 * 60 * 1000
export const ALERT_AFTER_INCOMPLETE = 3

// ADR-75 scheduling. STARTING VALUES — how long one page takes on real Cloud
// Storage is unmeasured, so none of these is a latency promise.
export const ROUTINE_BUDGET_MS = 45 * 1000      // routine share of one run
export const HARD_STOP_MS = 255 * 1000          // no page starts after this
export const URGENT_SLICE_MS = 60 * 1000        // only while another urgent company waits
export const PERIODIC_SLICE_MS = 30 * 1000      // only while another periodic company waits
export const PLAN_BUDGET_MS = 15 * 1000
export const PLAN_BATCH = 100
export const PLAN_EVERY_MS = 60 * 60 * 1000
export const MAX_INTERRUPTIONS = 5              // consecutive failed runs before a sweep is closed as incomplete
export const OVERDUE_FACTOR = 2
export const MAX_INTERVAL_HOURS = 168
export const LOG_RESULTS_MAX = 25
// Planning pauses while this many periodic requests are already queued, so a
// first activation over many companies cannot flood the queue the worker
// reads on every run. Eligibility lives on the company, so pausing skips
// nobody: the pass simply continues once the backlog has drained.
export const PERIODIC_BACKLOG_MAX = 200

// The configured interval. `raw` is the environment value exactly as written.
//   absent        → OFF (the approved default)            valid
//   "0"           → OFF, explicitly                       valid
//   "1" … "168"   → that many hours                       valid
//   anything else → INVALID. It is still OFF — a bad value never switches the
//                   feature on — but it is never SILENTLY off: the caller
//                   must report it (runScheduledWorker fails the run).
export function reconcileSetting(raw) {
  if (raw === undefined || raw === null) return { valid: true, hours: 0, ms: 0, configured: false }
  const text = typeof raw === 'number' ? String(raw) : raw
  const ok = typeof text === 'string' && /^(0|[1-9][0-9]{0,2})$/.test(text) && Number(text) <= MAX_INTERVAL_HOURS
  if (!ok) return { valid: false, hours: 0, ms: 0, configured: true }
  return { valid: true, hours: Number(text), ms: Number(text) * 60 * 60 * 1000, configured: true }
}
export const reconcileIntervalMs = (raw) => reconcileSetting(raw).ms

const isOutstanding = (state) => !!state && ((state.requestSeq ?? 0) > (state.completedSeq ?? 0) || !!state.pass)

// DUE: nothing outstanding, and the last SUCCESSFUL sweep STARTED at least one
// interval ago (or there has never been one). An incomplete sweep does not
// move `completedPassStartedAt`, so it cannot make a company "not due".
export function reconciliationDue(state, nowMs, intervalMs) {
  if (!(intervalMs > 0) || isOutstanding(state)) return false
  const started = toMillis(state?.completedPassStartedAt)
  return started === null || nowMs - started >= intervalMs
}

// OVERDUE: two intervals without a successful sweep. A company never swept is
// measured from when its first request was queued.
export function reconciliationOverdue(state, nowMs, intervalMs) {
  if (!(intervalMs > 0) || !state) return false
  const reference = toMillis(state.completedPassStartedAt) ?? (isOutstanding(state) ? toMillis(state.queuedAt) : null)
  return reference !== null && nowMs - reference > OVERDUE_FACTOR * intervalMs
}

// A role change reduces FILE access only when it leaves the internal set:
// storage.rules lets every member read drawings, and lets the three internal
// roles read every general document — an external role reads only documents
// marked `visibility: 'project'`.
export const reducesFileAccess = (fromRole, toRole) => isInternalRole(fromRole) && !isInternalRole(toRole)

// ── Requesting a sweep ───────────────────────────────────────────────────────
//
// INSIDE a membership transaction. Firestore requires every read before the
// first write, so the caller reads `stateRef` with its other reads and passes
// the snapshot in. Returns the sequence number to stamp on the member.
export function requestRevocationInTx(tx, db, companyId, stateSnap, { now, actorUid = null, targetUid = null, reason, requestId = null, source = 'callable' }) {
  if (!Object.values(REASON).includes(reason)) throw new Error(`Unknown file-link revocation reason: ${reason}`)
  if (reason === REASON.PERIODIC) throw new Error('file-links: a periodic request is written by the planner only')
  const prev = stateSnap.exists ? stateSnap.data() : {}
  const seq = (prev.requestSeq ?? 0) + 1
  const ts = Timestamp.fromDate(now)
  // ADR-75: how long this company has been waiting. An earlier request that is
  // still outstanding keeps its place in the queue; a new one does not push
  // the company to the back.
  const waiting = isOutstanding(prev)
  const queuedAt = waiting ? (prev.queuedAt ?? prev.requestedAt ?? ts) : ts
  tx.set(stateRef(db, companyId), {
    requestSeq: seq, requestedAt: ts, requestedBy: actorUid, requestReason: reason,
    // Every request through here is URGENT, and it overrides a periodic one.
    requestPriority: PRIORITY.URGENT, queuedAt,
    completedSeq: prev.completedSeq ?? 0,
    // A new request must not wait out an earlier sweep's retry backoff.
    nextAttemptAt: FieldValue.delete(),
  }, { merge: true })
  tx.set(markerRef(db, companyId), {
    companyId, requestSeq: seq, requestedAt: ts, queuedAt, priority: PRIORITY.URGENT,
    ...(waiting ? {} : { servedAt: FieldValue.delete() }),
  }, { merge: true })
  auditInTx(tx, db, companyId, {
    type: AUDIT.FILE_LINKS_REVOCATION_REQUESTED, actorUid, targetUid, after: { seq, reason }, requestId, source,
  }, now)
  return seq
}

// Stand-alone request (operator script). Refuses a company that does not exist.
export async function requestRevocation({ db, now }, { companyId, actorUid = 'operator', reason = REASON.OPERATOR, source = 'operator' }) {
  if (!isValidId(companyId)) throw new Error('file-links: invalid company id')
  const nowDate = now()
  return db.runTransaction(async (tx) => {
    const [company, state] = await Promise.all([tx.get(companyRef(db, companyId)), tx.get(stateRef(db, companyId))])
    if (!company.exists) throw new Error(`Company ${companyId} does not exist`)
    return requestRevocationInTx(tx, db, companyId, state, { now: nowDate, actorUid, reason, source })
  })
}

// The PLANNER's request (ADR-75): priority `periodic`, written ONLY when the
// company is due and nothing is outstanding — re-checked here, inside the
// transaction, so two planners (or a planner and a deactivation) cannot both
// write. It therefore never lowers a priority, never touches a retry backoff,
// and never writes an audit event: a routine request is not evidence.
export async function requestPeriodicSweep({ db, now }, companyId, intervalMs) {
  if (!isValidId(companyId)) return { requested: false, reason: 'invalid' }
  const nowDate = now()
  return db.runTransaction(async (tx) => {
    const [company, snap] = await Promise.all([tx.get(companyRef(db, companyId)), tx.get(stateRef(db, companyId))])
    if (!company.exists) return { requested: false, reason: 'gone' }
    const prev = snap.exists ? snap.data() : {}
    if (!reconciliationDue(prev, nowDate.getTime(), intervalMs)) return { requested: false, reason: 'not-due' }
    const seq = (prev.requestSeq ?? 0) + 1
    const ts = Timestamp.fromDate(nowDate)
    tx.set(stateRef(db, companyId), {
      requestSeq: seq, requestedAt: ts, requestedBy: 'worker', requestReason: REASON.PERIODIC,
      requestPriority: PRIORITY.PERIODIC, queuedAt: ts, completedSeq: prev.completedSeq ?? 0,
    }, { merge: true })
    tx.set(markerRef(db, companyId), { companyId, requestSeq: seq, requestedAt: ts, queuedAt: ts, priority: PRIORITY.PERIODIC })
    return { requested: true, seq }
  })
}

// ── The worker's transactions ────────────────────────────────────────────────

const leaseHeldByOther = (state, owner, nowMs) =>
  !!state.lease && state.lease.owner !== owner && (toMillis(state.lease.expiresAt) ?? 0) > nowMs

const backoffFor = (n) => Math.min(60 * 1000 * 2 ** Math.max(0, n - 1), MAX_BACKOFF_MS)

class LeaseLost extends Error {}

// Take (or re-take) the company's lease and start a sweep if none is open.
//
// `servedAt` is stamped HERE, when the turn starts, not when it ends: a run
// that is killed mid-page (timeout, crash, deploy) never reaches its own
// bookkeeping, and without this stamp the company would stay at the front of
// its class and be served first again every time.
//
// For the same reason a lease left behind by ANOTHER owner and now expired is
// counted as a failed run: that owner never released it. Five in a row close
// the sweep as incomplete, exactly as five reported failures do — otherwise a
// company whose pages always hang would be retried for ever without backoff.
async function acquire({ db, now, log }, companyId, owner) {
  const nowDate = now()
  const nowMs = nowDate.getTime()
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(stateRef(db, companyId))
    const state = snap.exists ? snap.data() : null
    if (!isOutstanding(state)) {
      tx.delete(markerRef(db, companyId))
      return { action: 'none' }
    }
    if (leaseHeldByOther(state, owner, nowMs)) return { action: 'busy' }
    if (!state.pass && (toMillis(state.nextAttemptAt) ?? 0) > nowMs) return { action: 'backoff' }
    const fresh = (extra = {}) => ({
      seq: state.requestSeq, startedAt: Timestamp.fromDate(nowDate), pageToken: null,
      pages: 0, scanned: 0, removed: 0, failed: 0,
      priority: priorityOf(state.requestPriority), ...extra,
    })
    // ADR-75 PRE-EMPTION. An urgent request that arrived while a PERIODIC
    // sweep was open is not covered by it (that sweep started first). Replace
    // the periodic sweep with a new one at the urgent sequence: it covers
    // both. The abandoned sweep is NOT finished — completedSeq,
    // completedPassStartedAt, lastPass and the audit trail are untouched. An
    // urgent sweep is never pre-empted, so this happens at most once a sweep.
    const preempted = !!state.pass
      && priorityOf(state.pass.priority) === PRIORITY.PERIODIC
      && priorityOf(state.requestPriority) === PRIORITY.URGENT
      && (state.requestSeq ?? 0) > (state.pass.seq ?? 0)
    let pass = preempted ? fresh({ restarts: (state.pass.restarts ?? 0) + 1 }) : (state.pass ?? fresh())
    tx.set(markerRef(db, companyId), { servedAt: Timestamp.fromDate(nowDate) }, { merge: true })
    const abandoned = !preempted && !!state.pass && !!state.lease && state.lease.owner !== owner
    if (abandoned) {
      const errors = (pass.errors ?? 0) + 1
      if (errors >= MAX_INTERRUPTIONS) {
        return closeIncomplete(tx, db, companyId, state, summaryOf(pass), nowDate, { source: sourceOf(owner), log, extra: { interrupted: true } })
      }
      pass = { ...pass, errors }
    }
    tx.update(stateRef(db, companyId), { pass, lease: { owner, expiresAt: Timestamp.fromMillis(nowMs + LEASE_MS) } })
    return { action: 'sweep', pass, preempted }
  })
}

// Record one finished page and renew the lease. A worker that has lost its
// lease stops here and writes nothing.
async function checkpoint({ db, now }, companyId, owner, page) {
  const nowMs = now().getTime()
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(stateRef(db, companyId))
    const state = snap.exists ? snap.data() : null
    if (!state?.pass || state.lease?.owner !== owner) throw new LeaseLost()
    const pass = {
      ...state.pass,
      pageToken: page.nextPageToken ?? null,
      pages: (state.pass.pages ?? 0) + 1,
      scanned: (state.pass.scanned ?? 0) + page.scanned,
      removed: (state.pass.removed ?? 0) + page.removed,
      failed: (state.pass.failed ?? 0) + page.failed,
      // A page went through: whatever interrupted earlier runs has cleared.
      errors: 0,
    }
    tx.update(stateRef(db, companyId), { pass, lease: { owner, expiresAt: Timestamp.fromMillis(nowMs + LEASE_MS) } })
    return pass
  })
}

async function release({ db }, companyId, owner) {
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(stateRef(db, companyId))
    if (snap.exists && snap.data().lease?.owner === owner) tx.update(stateRef(db, companyId), { lease: FieldValue.delete() })
  })
}

// A DELIBERATE yield (ADR-75): the slice or the run's budget is used up. The
// checkpoint stands and the lease is released. This is not a failure — nothing
// counts towards the sweep being closed as incomplete. `servedAt` on the
// marker sends the company to the back of its class.
async function yieldTurn({ db, now }, companyId, owner) {
  const ts = Timestamp.fromDate(now())
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(stateRef(db, companyId))
    const state = snap.exists ? snap.data() : null
    if (!state || state.lease?.owner !== owner) return
    const update = { lease: FieldValue.delete() }
    if (state.pass) update.pass = { ...state.pass, yields: (state.pass.yields ?? 0) + 1 }
    tx.update(stateRef(db, companyId), update)
    tx.set(markerRef(db, companyId), { servedAt: ts }, { merge: true })
  })
}

const closeIncomplete = (tx, db, companyId, state, summary, nowDate, { source, log, extra = {} }) => {
  const ts = Timestamp.fromDate(nowDate)
  const n = (state.consecutiveIncomplete ?? 0) + 1
  tx.update(stateRef(db, companyId), {
    lastPass: { ...summary, ...extra, complete: false, finishedAt: ts },
    consecutiveIncomplete: n, nextAttemptAt: Timestamp.fromMillis(nowDate.getTime() + backoffFor(n)),
    pass: FieldValue.delete(), lease: FieldValue.delete(),
  })
  // The first incomplete sweep and the alert threshold are evidence; the
  // retries in between are not written, so a stuck object cannot flood the
  // audit trail.
  if (n === 1 || n === ALERT_AFTER_INCOMPLETE) {
    auditInTx(tx, db, companyId, { type: AUDIT.FILE_LINKS_REVOCATION_INCOMPLETE, after: { ...summary, ...extra, consecutiveIncomplete: n }, source }, nowDate)
  }
  const level = n >= ALERT_AFTER_INCOMPLETE ? 'error' : 'warn'
  log?.[level]?.('file-links: sweep incomplete; old links may still work', { companyId, ...summary, ...extra, consecutiveIncomplete: n })
  return { action: 'incomplete', consecutiveIncomplete: n, ...summary, ...extra }
}

const summaryOf = (pass) => ({ seq: pass.seq, pages: pass.pages ?? 0, scanned: pass.scanned ?? 0, removed: pass.removed ?? 0, failed: pass.failed ?? 0 })
const sourceOf = (owner) => (owner.startsWith('operator') ? 'operator' : 'worker')

// A run that FAILED (listing or Firestore), as opposed to one that yielded.
// The checkpoint is kept and the failure is counted. The fifth CONSECUTIVE
// failed run closes the sweep as INCOMPLETE, which puts the company on the
// ordinary backoff and alert path instead of retrying every minute for ever.
// The request stays outstanding, and the retry — a new sweep — starts from the
// first page.
//
// That restart is also the ONLY recovery from a saved listing position that
// Cloud Storage will no longer accept. No error is ever read as "the page
// token expired": the installed client reports an HTTP status and a reason
// string, neither documented for that case, and a 400 can equally be a
// malformed request. Guessing would turn an unrelated fault into a restart.
// completedSeq and completedPassStartedAt are never touched here.
async function interrupted({ db, now, log }, companyId, owner) {
  const nowDate = now()
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(stateRef(db, companyId))
    const state = snap.exists ? snap.data() : null
    if (!state?.pass || state.lease?.owner !== owner) return { action: 'error' }
    const { pass } = state
    const errors = (pass.errors ?? 0) + 1
    tx.set(markerRef(db, companyId), { servedAt: Timestamp.fromDate(nowDate) }, { merge: true })
    if (errors >= MAX_INTERRUPTIONS) {
      return closeIncomplete(tx, db, companyId, state, summaryOf(pass), nowDate, { source: sourceOf(owner), log, extra: { interrupted: true } })
    }
    tx.update(stateRef(db, companyId), { pass: { ...pass, errors }, lease: FieldValue.delete() })
    return { action: 'error', errors }
  })
}

// Close the sweep. COMPLETE only when not one object failed; otherwise the
// request stays outstanding and a fresh sweep is scheduled with a backoff.
async function finish({ db, now, log }, companyId, owner) {
  const nowDate = now()
  const ts = Timestamp.fromDate(nowDate)
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(stateRef(db, companyId))
    const state = snap.exists ? snap.data() : null
    if (!state?.pass || state.lease?.owner !== owner) throw new LeaseLost()
    const { pass } = state
    const summary = summaryOf(pass)
    const periodic = priorityOf(pass.priority) === PRIORITY.PERIODIC

    if (summary.failed === 0) {
      tx.update(stateRef(db, companyId), {
        completedSeq: pass.seq, completedAt: ts, completedPassStartedAt: pass.startedAt,
        lastPass: { ...summary, complete: true, finishedAt: ts, ...(periodic ? { priority: PRIORITY.PERIODIC } : {}) },
        consecutiveIncomplete: 0, nextAttemptAt: FieldValue.delete(), pass: FieldValue.delete(), lease: FieldValue.delete(),
        overdueSince: FieldValue.delete(),
      })
      const more = (state.requestSeq ?? 0) > pass.seq
      if (!more) tx.delete(markerRef(db, companyId))
      // ADR-75: a ROUTINE sweep that found nothing is not evidence and writes
      // no audit event (its record is `lastPass` and the worker's log line).
      // One that REMOVED a token is: tokens existed that no access change
      // explained. An urgent sweep is audited exactly as before.
      if (!periodic) auditInTx(tx, db, companyId, { type: AUDIT.FILE_LINKS_REVOKED, after: summary, source: sourceOf(owner) }, nowDate)
      else if (summary.removed > 0) auditInTx(tx, db, companyId, { type: AUDIT.FILE_LINKS_RECONCILED, after: summary, source: sourceOf(owner) }, nowDate)
      return { action: 'complete', more, ...summary }
    }

    return closeIncomplete(tx, db, companyId, state, summary, nowDate, { source: sourceOf(owner), log })
  })
}

// ── One company ──────────────────────────────────────────────────────────────
//
// Resumable: progress is saved after every page, so a crash, a deploy or the
// time budget costs at most one page of repeated (harmless) work.
export async function processCompany(deps, companyId, { owner, deadlineMs = Infinity, sweepOptions = {} }) {
  const { bucket, now, log } = deps
  if (!isValidId(companyId)) {
    log?.error?.('file-links: refusing an invalid company id in the queue')
    return { companyId, action: 'invalid' }
  }
  const got = await acquire(deps, companyId, owner)
  if (got.action !== 'sweep') return { companyId, ...got }

  if (got.preempted) log?.info?.('file-links: periodic sweep replaced by an urgent one', { companyId, seq: got.pass.seq })
  let pageToken = got.pass.pageToken ?? null
  try {
    for (;;) {
      // The ONLY place a sweep stops on purpose: between pages, never inside one.
      if (now().getTime() >= deadlineMs) {
        await yieldTurn(deps, companyId, owner)
        return { companyId, action: 'yielded' }
      }
      const page = await sweepPage(bucket, companyId, pageToken, { log, ...sweepOptions })
      await checkpoint(deps, companyId, owner, page)
      if (!page.nextPageToken) break
      pageToken = page.nextPageToken
    }
    return { companyId, ...(await finish(deps, companyId, owner)) }
  } catch (err) {
    if (err instanceof LeaseLost) return { companyId, action: 'lease-lost' }
    // Listing or Firestore failed. The checkpoint stands; the next run resumes.
    log?.error?.('file-links: sweep interrupted; will resume', { companyId, status: err?.code ?? null, message: String(err?.message ?? err).slice(0, 200) })
    try {
      return { companyId, ...(await interrupted(deps, companyId, owner)) }
    } catch {
      try { await release(deps, companyId, owner) } catch { /* the lease expires on its own */ }
      return { companyId, action: 'error' }
    }
  }
}

// ── Planning (ADR-75) ────────────────────────────────────────────────────────
//
// One bounded batch of the current planning pass. See the header: the cursor
// only remembers how far THIS pass has walked.

const isCount = (v) => Number.isSafeInteger(v) && v >= 0
const isTime = (v) => v === null || v === undefined || toMillis(v) !== null
const isDocId = (v) => typeof v === 'string' && v.length > 0 && v.length <= 1500 && !v.includes('/')

// The cursor document as plain values, or null when it cannot be trusted.
export function readCursor(data) {
  if (data === null || typeof data !== 'object') return null
  const open = data.passStartedAt !== null && data.passStartedAt !== undefined
  if (!isCount(data.passSeq) || !isTime(data.passStartedAt) || !isTime(data.nextPassAt)) return null
  if (open && toMillis(data.passStartedAt) === null) return null
  if (data.cursor !== null && data.cursor !== undefined && !isDocId(data.cursor)) return null
  if (!open && data.cursor) return null
  for (const k of ['examined', 'requested', 'overdue', 'invalid']) if (data[k] !== undefined && !isCount(data[k])) return null
  return {
    passSeq: data.passSeq, open,
    passStartedAtMs: open ? toMillis(data.passStartedAt) : null,
    cursor: open ? (data.cursor ?? null) : null,
    examined: open ? (data.examined ?? 0) : 0, requested: open ? (data.requested ?? 0) : 0,
    overdue: open ? (data.overdue ?? 0) : 0, invalid: open ? (data.invalid ?? 0) : 0,
    oldestMs: open ? toMillis(data.oldestSweepStartedAt) : null,
    nextPassAtMs: toMillis(data.nextPassAt) ?? 0,
    lastPass: data.lastPass && typeof data.lastPass === 'object' ? data.lastPass : null,
  }
}

const sameVersion = (a, b) => (a.exists === b.exists) && (!a.exists || a.updateTime.isEqual(b.updateTime))

// First time a company is seen overdue: one flag and one audit event. The flag
// is cleared by the next successful sweep, so this is once per episode.
async function markOverdue({ db, now }, companyId, intervalMs) {
  const nowDate = now()
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(stateRef(db, companyId))
    const state = snap.exists ? snap.data() : null
    if (!state || state.overdueSince || !reconciliationOverdue(state, nowDate.getTime(), intervalMs)) return
    tx.update(stateRef(db, companyId), { overdueSince: Timestamp.fromDate(nowDate) })
    auditInTx(tx, db, companyId, {
      type: AUDIT.FILE_LINKS_RECONCILIATION_OVERDUE, source: 'worker',
      after: { lastSuccessfulSweepStartedAt: toIso(state.completedPassStartedAt), intervalHours: intervalMs / 3600000, consecutiveIncomplete: state.consecutiveIncomplete ?? 0 },
    }, nowDate)
  })
}

export async function planReconciliation(deps, { intervalMs, deadlineMs = Infinity, batchSize = PLAN_BATCH } = {}) {
  const { db, now, log } = deps
  if (!(intervalMs > 0)) return { action: 'off' }
  const ref = cursorRef(db)
  const snap = await ref.get()
  let cur = snap.exists ? readCursor(snap.data()) : null
  const corrupted = snap.exists && cur === null
  if (corrupted) {
    const seq = snap.data()?.passSeq
    log?.error?.('file-links: reconciliation cursor unreadable; planning restarts from the first company', { passSeq: isCount(seq) ? seq : null })
    cur = { passSeq: isCount(seq) ? seq : 0, open: false, nextPassAtMs: 0, lastPass: null }
  }
  cur ??= { passSeq: 0, open: false, nextPassAtMs: 0, lastPass: null }

  const startedMs = now().getTime()
  if (!cur.open) {
    if (startedMs < cur.nextPassAtMs) return { action: 'idle', passSeq: cur.passSeq }
    cur = { ...cur, open: true, passSeq: cur.passSeq + 1, passStartedAtMs: startedMs, cursor: null, examined: 0, requested: 0, overdue: 0, invalid: 0, oldestMs: null }
  }

  let q = db.collection('companies').orderBy(FieldPath.documentId()).limit(batchSize)
  if (cur.cursor) q = q.startAfter(cur.cursor)
  const page = await q.select().get()

  let { cursor, examined, requested, overdue, invalid, oldestMs } = cur
  let taken = 0
  for (const doc of page.docs) {
    // Always at least one, so a pass cannot stall; then stop on the budget.
    if (taken > 0 && now().getTime() >= deadlineMs) break
    taken += 1
    cursor = doc.id
    examined += 1
    if (!isValidId(doc.id)) { invalid += 1; continue }
    const stateSnap = await stateRef(db, doc.id).get()
    const state = stateSnap.exists ? stateSnap.data() : null
    const nowMs = now().getTime()
    const lastStart = toMillis(state?.completedPassStartedAt)
    if (lastStart !== null && (oldestMs === null || lastStart < oldestMs)) oldestMs = lastStart
    if (reconciliationOverdue(state, nowMs, intervalMs)) {
      overdue += 1
      if (!state.overdueSince) await markOverdue(deps, doc.id, intervalMs)
    }
    if (reconciliationDue(state, nowMs, intervalMs)) {
      const r = await requestPeriodicSweep(deps, doc.id, intervalMs)
      if (r.requested) requested += 1
    }
  }
  // The pass ends only at the END of the collection: a short page, all of it
  // examined.
  const finished = taken === page.docs.length && page.docs.length < batchSize

  const nowDate = now()
  const counts = { examined, requested, overdue, invalid }
  const saved = await db.runTransaction(async (tx) => {
    // Compare-and-set: save only if nobody changed the cursor since it was read.
    const again = await tx.get(ref)
    if (!sameVersion(snap, again)) return false
    tx.set(ref, finished ? {
      passSeq: cur.passSeq, passStartedAt: null, cursor: null, examined: 0, requested: 0, overdue: 0, invalid: 0, oldestSweepStartedAt: null,
      lastPass: {
        seq: cur.passSeq, startedAt: Timestamp.fromMillis(cur.passStartedAtMs), completedAt: Timestamp.fromDate(nowDate), ...counts,
        oldestSweepStartedAt: oldestMs === null ? null : Timestamp.fromMillis(oldestMs),
      },
      nextPassAt: Timestamp.fromMillis(cur.passStartedAtMs + PLAN_EVERY_MS),
      intervalHours: intervalMs / 3600000, updatedAt: Timestamp.fromDate(nowDate),
    } : {
      passSeq: cur.passSeq, passStartedAt: Timestamp.fromMillis(cur.passStartedAtMs), cursor, ...counts,
      oldestSweepStartedAt: oldestMs === null ? null : Timestamp.fromMillis(oldestMs),
      lastPass: cur.lastPass, nextPassAt: Timestamp.fromMillis(cur.nextPassAtMs),
      intervalHours: intervalMs / 3600000, updatedAt: Timestamp.fromDate(nowDate),
    })
    return true
  })
  if (!saved) {
    // Requests already written stand; they make those companies "outstanding",
    // so whoever plans next passes over them.
    log?.warn?.('file-links: reconciliation cursor changed underneath this run; batch not recorded', { passSeq: cur.passSeq })
    return { action: 'conflict', passSeq: cur.passSeq, batch: taken }
  }
  if (finished) {
    // The HEARTBEAT: one line per finished pass. Its absence means planning stopped.
    log?.info?.('file-links: reconciliation plan complete', { passSeq: cur.passSeq, ...counts, oldestSweepStartedAt: oldestMs === null ? null : new Date(oldestMs).toISOString() })
    if (overdue > 0) log?.error?.('file-links: reconciliation overdue; tokens in these companies are older than the bound', { passSeq: cur.passSeq, companies: overdue })
  }
  return { action: finished ? 'finished' : 'advanced', passSeq: cur.passSeq, batch: taken, restarted: corrupted, ...counts }
}

// ── The scheduled worker ─────────────────────────────────────────────────────
//
// ONE run = read the queue once, then two phases (ADR-75):
//   URGENT  — membership and operator requests, least recently served first.
//             Ends at `budgetMs`, or `routineBudgetMs` earlier when routine
//             work is waiting.
//   ROUTINE — planning, then periodic sweeps; at most `routineBudgetMs`, in
//             every run that has routine work, even if urgent work remains.
// A company yields to the next of its class after a slice ONLY when another is
// waiting; a lone company runs to the end of its phase, exactly as in ADR-74.
// With `reconcileIntervalMs` 0 there is no planning and no cursor I/O at all.
const orderKey = (m) => toMillis(m.servedAt) ?? toMillis(m.queuedAt) ?? toMillis(m.requestedAt) ?? 0

async function servePhase(deps, entries, results, { owner, sweepOptions, phaseEndMs, sliceMs }) {
  const { now } = deps
  const queue = [...entries]
  const seen = new Set()
  while (queue.length > 0 && now().getTime() < phaseEndMs) {
    const companyId = queue.shift()
    seen.add(companyId)
    const deadlineMs = queue.length > 0 ? Math.min(phaseEndMs, now().getTime() + sliceMs) : phaseEndMs
    const r = await processCompany(deps, companyId, { owner, deadlineMs, sweepOptions })
    results.push(r)
    // Still has work this run can do: a slice that ran out, or a request that
    // arrived during the sweep. Back of the line.
    if (r.action === 'yielded' || (r.action === 'complete' && r.more)) queue.push(companyId)
  }
  for (const companyId of queue) if (!seen.has(companyId)) results.push({ companyId, action: 'deferred' })
}

export async function runRevocationWorker(deps, {
  owner, budgetMs = WORK_BUDGET_MS, sweepOptions = {},
  reconcileIntervalMs: intervalMs = 0, routineBudgetMs = ROUTINE_BUDGET_MS, hardStopMs = HARD_STOP_MS, planBatch = PLAN_BATCH,
} = {}) {
  const { db, now, log } = deps
  const startMs = now().getTime()
  const queue = await db.collectionGroup(QUEUE_COLLECTION).get()
  const urgent = []
  const periodic = []
  for (const doc of queue.docs) {
    // Only companies/{c}/fileLinkRevocationQueue/pending counts.
    const company = doc.ref.parent.parent
    if (doc.id !== MARKER_ID || !company || company.parent.id !== 'companies' || company.parent.parent) continue
    const m = doc.data()
    ;(priorityOf(m.priority) === PRIORITY.PERIODIC ? periodic : urgent).push({ companyId: company.id, key: orderKey(m) })
  }
  const inOrder = (list) => list.sort((a, b) => a.key - b.key || (a.companyId < b.companyId ? -1 : 1)).map(e => e.companyId)

  // Routine work is waiting if a periodic request is queued, or planning is on
  // and due. The cursor is read ONLY when reconciliation is switched on.
  let planDue = false
  if (intervalMs > 0) {
    try {
      const snap = await cursorRef(db).get()
      const cur = snap.exists ? readCursor(snap.data()) : null
      planDue = cur === null || cur.open || startMs >= cur.nextPassAtMs
    } catch (err) {
      log?.error?.('file-links: reconciliation cursor could not be read', { message: String(err?.message ?? err).slice(0, 200) })
    }
  }
  // A full periodic queue pauses planning (not sweeping) until it drains.
  const backlogFull = periodic.length >= PERIODIC_BACKLOG_MAX
  if (planDue && backlogFull) {
    planDue = false
    log?.info?.('file-links: reconciliation planning paused; periodic queue is full', { periodic: periodic.length })
  }
  const routineWaiting = periodic.length > 0 || planDue

  const results = []
  const urgentEndMs = startMs + (routineWaiting ? Math.max(0, budgetMs - routineBudgetMs) : budgetMs)
  await servePhase(deps, inOrder(urgent), results, { owner, sweepOptions, phaseEndMs: urgentEndMs, sliceMs: URGENT_SLICE_MS })

  let plan = null
  if (routineWaiting) {
    const hardEndMs = startMs + hardStopMs
    if (now().getTime() >= hardEndMs) {
      log?.warn?.('file-links: urgent work used the whole run; routine work skipped this time', { periodic: periodic.length, planDue })
      for (const e of periodic) results.push({ companyId: e.companyId, action: 'deferred' })
    } else {
      const routineEndMs = Math.min(now().getTime() + routineBudgetMs, hardEndMs)
      if (planDue) {
        // Planning never blocks revocation: its failure is logged, not thrown.
        try {
          plan = await planReconciliation(deps, { intervalMs, deadlineMs: Math.min(now().getTime() + PLAN_BUDGET_MS, routineEndMs), batchSize: planBatch })
        } catch (err) {
          plan = { action: 'error' }
          log?.error?.('file-links: reconciliation planning failed; will retry next run', { message: String(err?.message ?? err).slice(0, 200) })
        }
      }
      await servePhase(deps, inOrder(periodic), results, { owner, sweepOptions, phaseEndMs: routineEndMs, sliceMs: PERIODIC_SLICE_MS })
    }
  }

  if (results.length > 0 || (plan && plan.action !== 'idle')) {
    // BOUNDED: counts always, at most LOG_RESULTS_MAX individual results.
    const actions = {}
    for (const r of results) actions[r.action] = (actions[r.action] ?? 0) + 1
    log?.info?.('file-links: worker run', {
      companies: results.length, urgent: urgent.length, periodic: periodic.length, actions,
      results: results.slice(0, LOG_RESULTS_MAX), truncated: Math.max(0, results.length - LOG_RESULTS_MAX),
      ...(plan ? { plan } : {}),
    })
  }
  if (plan) Object.defineProperty(results, 'plan', { value: plan, enumerable: false })
  return results
}

// The scheduled function's body. Revocation work ALWAYS runs. An interval
// that is set but unusable is not allowed to switch a security control off
// quietly: reconciliation stays off, the queued urgent work is done, and then
// the run FAILS with an error that names the setting — visible in the logs,
// in the function's error rate and in the Scheduler job's status.
export class InvalidReconcileInterval extends Error {
  constructor() {
    super('FILE_LINK_RECONCILE_INTERVAL_HOURS is set but is not 0 or a whole number of hours from 1 to 168. Periodic reconciliation is NOT running. Fix the value in functions/.env.<projectId> and redeploy.')
    this.name = 'InvalidReconcileInterval'
  }
}

export async function runScheduledWorker(deps, { owner, reconcileIntervalRaw, ...options } = {}) {
  const setting = reconcileSetting(reconcileIntervalRaw)
  const results = await runRevocationWorker(deps, { owner, ...options, reconcileIntervalMs: setting.ms })
  if (!setting.valid) {
    const err = new InvalidReconcileInterval()
    deps.log?.error?.(`file-links: ${err.message}`)
    throw err
  }
  return results
}

// ── Status — PURE ────────────────────────────────────────────────────────────
export const FILE_LINK_STATUS = { PENDING: 'pending', REVOKED: 'revoked', DELAYED: 'delayed', NOT_REQUESTED: 'not_requested' }

// `member`: { seq, reducedAtMs, deactivated } from members/{uid}.
//   seq          — the request sequence stamped by the membership transaction
//   reducedAtMs  — when their file access was reduced
// A member deactivated BEFORE this feature has no seq: they are covered only
// by a completed sweep that started clearly after their deactivation.
export function fileLinkStatus(member, state, nowMs) {
  const seq = Number.isInteger(member?.seq) ? member.seq : null
  if (seq === null && !member?.deactivated) return null
  const completedSeq = state?.completedSeq ?? 0
  if (seq !== null && completedSeq >= seq) return FILE_LINK_STATUS.REVOKED
  if (seq === null) {
    const started = toMillis(state?.completedPassStartedAt)
    if (started !== null && member.reducedAtMs !== null && started >= member.reducedAtMs + LEGACY_MARGIN_MS) return FILE_LINK_STATUS.REVOKED
    if ((state?.requestSeq ?? 0) <= completedSeq && !state?.pass) return FILE_LINK_STATUS.NOT_REQUESTED
  }
  if ((state?.consecutiveIncomplete ?? 0) > 0) return FILE_LINK_STATUS.DELAYED
  const since = seq !== null ? member.reducedAtMs : toMillis(state?.requestedAt)
  if (since !== null && since !== undefined && nowMs - since > DELAY_AFTER_MS) return FILE_LINK_STATUS.DELAYED
  return FILE_LINK_STATUS.PENDING
}

// The row fragment listTeam returns. Counts and times only.
export function fileLinkRow(memberDoc, { deactivated }, state, nowMs) {
  const member = {
    seq: memberDoc?.fileLinkRevocationSeq ?? null,
    reducedAtMs: toMillis(memberDoc?.fileAccessReducedAt) ?? (deactivated ? toMillis(memberDoc?.deactivatedAt) : null),
    deactivated,
  }
  const status = fileLinkStatus(member, state, nowMs)
  if (status === null) return null
  return {
    status,
    since: member.reducedAtMs === null ? null : new Date(member.reducedAtMs).toISOString(),
    lastCompletedAt: toIso(state?.completedAt),
    outstanding: status === FILE_LINK_STATUS.DELAYED ? state?.lastPass?.failed ?? null : null,
  }
}
