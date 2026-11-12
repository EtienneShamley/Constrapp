import { FieldValue, Timestamp } from './firebaseAdmin.js'
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

export const QUEUE_COLLECTION = 'fileLinkRevocationQueue'
export const MARKER_ID = 'pending'
export const stateRef = (db, companyId) => companyRef(db, companyId).collection('system').doc('fileLinkRevocation')
export const markerRef = (db, companyId) => companyRef(db, companyId).collection(QUEUE_COLLECTION).doc(MARKER_ID)

export const REASON = { DEACTIVATED: 'member.deactivated', ROLE_REDUCED: 'member.role_reduced', OPERATOR: 'operator' }

export const LEASE_MS = 6 * 60 * 1000
export const WORK_BUDGET_MS = 4 * 60 * 1000
export const DELAY_AFTER_MS = 15 * 60 * 1000
export const LEGACY_MARGIN_MS = 10 * 60 * 1000
export const MAX_BACKOFF_MS = 60 * 60 * 1000
export const ALERT_AFTER_INCOMPLETE = 3

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
  const prev = stateSnap.exists ? stateSnap.data() : {}
  const seq = (prev.requestSeq ?? 0) + 1
  const ts = Timestamp.fromDate(now)
  tx.set(stateRef(db, companyId), {
    requestSeq: seq, requestedAt: ts, requestedBy: actorUid, requestReason: reason,
    completedSeq: prev.completedSeq ?? 0,
    // A new request must not wait out an earlier sweep's retry backoff.
    nextAttemptAt: FieldValue.delete(),
  }, { merge: true })
  tx.set(markerRef(db, companyId), { companyId, requestSeq: seq, requestedAt: ts })
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

// ── The worker's three transactions ──────────────────────────────────────────

const leaseHeldByOther = (state, owner, nowMs) =>
  !!state.lease && state.lease.owner !== owner && (toMillis(state.lease.expiresAt) ?? 0) > nowMs

const backoffFor = (n) => Math.min(60 * 1000 * 2 ** Math.max(0, n - 1), MAX_BACKOFF_MS)

class LeaseLost extends Error {}

// Take (or re-take) the company's lease and start a sweep if none is open.
async function acquire({ db, now }, companyId, owner) {
  const nowDate = now()
  const nowMs = nowDate.getTime()
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(stateRef(db, companyId))
    const state = snap.exists ? snap.data() : null
    const outstanding = !!state && ((state.requestSeq ?? 0) > (state.completedSeq ?? 0) || !!state.pass)
    if (!outstanding) {
      tx.delete(markerRef(db, companyId))
      return { action: 'none' }
    }
    if (leaseHeldByOther(state, owner, nowMs)) return { action: 'busy' }
    if (!state.pass && (toMillis(state.nextAttemptAt) ?? 0) > nowMs) return { action: 'backoff' }
    const pass = state.pass ?? {
      seq: state.requestSeq, startedAt: Timestamp.fromDate(nowDate), pageToken: null,
      pages: 0, scanned: 0, removed: 0, failed: 0,
    }
    tx.update(stateRef(db, companyId), { pass, lease: { owner, expiresAt: Timestamp.fromMillis(nowMs + LEASE_MS) } })
    return { action: 'sweep', pass }
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
    const summary = { seq: pass.seq, pages: pass.pages ?? 0, scanned: pass.scanned ?? 0, removed: pass.removed ?? 0, failed: pass.failed ?? 0 }

    if (summary.failed === 0) {
      tx.update(stateRef(db, companyId), {
        completedSeq: pass.seq, completedAt: ts, completedPassStartedAt: pass.startedAt,
        lastPass: { ...summary, complete: true, finishedAt: ts },
        consecutiveIncomplete: 0, nextAttemptAt: FieldValue.delete(), pass: FieldValue.delete(), lease: FieldValue.delete(),
      })
      const more = (state.requestSeq ?? 0) > pass.seq
      if (!more) tx.delete(markerRef(db, companyId))
      auditInTx(tx, db, companyId, { type: AUDIT.FILE_LINKS_REVOKED, after: summary, source: owner.startsWith('operator') ? 'operator' : 'worker' }, nowDate)
      return { action: 'complete', more, ...summary }
    }

    const n = (state.consecutiveIncomplete ?? 0) + 1
    tx.update(stateRef(db, companyId), {
      lastPass: { ...summary, complete: false, finishedAt: ts },
      consecutiveIncomplete: n, nextAttemptAt: Timestamp.fromMillis(nowDate.getTime() + backoffFor(n)),
      pass: FieldValue.delete(), lease: FieldValue.delete(),
    })
    // The first incomplete sweep and the alert threshold are evidence; the
    // retries in between are not written, so a stuck object cannot flood the
    // audit trail.
    if (n === 1 || n === ALERT_AFTER_INCOMPLETE) {
      auditInTx(tx, db, companyId, { type: AUDIT.FILE_LINKS_REVOCATION_INCOMPLETE, after: { ...summary, consecutiveIncomplete: n }, source: owner.startsWith('operator') ? 'operator' : 'worker' }, nowDate)
    }
    const level = n >= ALERT_AFTER_INCOMPLETE ? 'error' : 'warn'
    log?.[level]?.('file-links: sweep incomplete; old links may still work', { companyId, ...summary, consecutiveIncomplete: n })
    return { action: 'incomplete', consecutiveIncomplete: n, ...summary }
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
  if (got.action !== 'sweep') return { companyId, action: got.action }

  let pageToken = got.pass.pageToken ?? null
  try {
    for (;;) {
      if (now().getTime() >= deadlineMs) {
        await release(deps, companyId, owner)
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
    try { await release(deps, companyId, owner) } catch { /* the lease expires on its own */ }
    return { companyId, action: 'error' }
  }
}

// ── The scheduled worker ─────────────────────────────────────────────────────
export async function runRevocationWorker(deps, { owner, budgetMs = WORK_BUDGET_MS, sweepOptions = {} } = {}) {
  const { db, now, log } = deps
  const deadlineMs = now().getTime() + budgetMs
  const queue = await db.collectionGroup(QUEUE_COLLECTION).get()
  const results = []
  for (const doc of queue.docs) {
    // Only companies/{c}/fileLinkRevocationQueue/pending counts.
    const company = doc.ref.parent.parent
    if (doc.id !== MARKER_ID || !company || company.parent.id !== 'companies' || company.parent.parent) continue
    if (now().getTime() >= deadlineMs) { results.push({ companyId: company.id, action: 'deferred' }); continue }
    let r = await processCompany(deps, company.id, { owner, deadlineMs, sweepOptions })
    // A request that arrived during the sweep: start its sweep in this run.
    if (r.action === 'complete' && r.more && now().getTime() < deadlineMs) {
      results.push(r)
      r = await processCompany(deps, company.id, { owner, deadlineMs, sweepOptions })
    }
    results.push(r)
  }
  if (results.length > 0) log?.info?.('file-links: worker run', { companies: results.length, results })
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
