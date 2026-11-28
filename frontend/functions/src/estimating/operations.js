import { createHash, randomUUID } from 'node:crypto'
import { FieldValue } from '../lib/firebaseAdmin.js'
import { CODE, fail } from '../lib/errors.js'
import { userRef, assertActiveRole } from '../lib/authz.js'
import { AUDIT, auditInTx } from '../lib/audit.js'
import { segregationGuard, createdEditorStamp, editorStamp } from '../lib/approvalPolicy.js'
import { requireCommercialActivationInTx } from '../lib/commercialActivation.js'
import * as calc from '../generated/estimatingCalc.js'

// ── Estimate revisions (ADR-97 — Phase 2 step 7, D1–D3) ──────────────────────
//
//   …/projects/{p}/estimates/{estimateId}              the revision HEADER
//   …/projects/{p}/estimates/{estimateId}/lines/{nnnnn} bounded line CHUNKS
//   …/projects/{p}/estimateItemInputs/{boqItemId}       optional rate breakdown
//   …/projects/{p}/estimateState/current                server-only: the next
//                                                       revision number and the
//                                                       current approved revision
//
// Firestore Rules let the financial roles READ the first three and let no
// client WRITE any of them; the fourth matches no Rule.
//
// ── BUILDING A REVISION (operation `build`) ──────────────────────────────────
//
// A revision is built by the backend from the BOQ it reads itself. It can be
// far larger than one transaction should write, so it is NOT one transaction —
// and it is still never partly authoritative:
//
//   1. SNAPSHOT READ. One READ-ONLY transaction reads the caller, the project,
//      the header, the whole `boqItems` register and the rate breakdowns at ONE
//      read time — a consistent picture of the BOQ. Everything is derived and
//      validated from it BEFORE anything is written; a BOQ that cannot be
//      estimated is refused with nothing written.
//   2. CLAIM. One transaction creates the header (state `building`, a fresh
//      `runId`, the revision number) or moves a draft to `building` under its
//      revision guard. `building` is never approvable.
//   3. CHUNKS. Bounded transactions each re-read the header and write chunk
//      documents ONLY while it still holds THIS run's id (the run fence); a
//      newer build or a discard changes the id and this run stops, typed.
//      Chunks left by an earlier, longer build are deleted the same way.
//   4. COMPLETE. One transaction — the caller's membership re-read in it, the
//      fence checked again — writes the settings, totals, line and chunk
//      counts, the BOQ source key, the SHA-256 of the canonical content, moves
//      the state to `draft` and records one audit event.
//
// INTERRUPTED between any two steps, the header stays `building`: it cannot be
// approved, the page says so, and any authorised member can rebuild it once
// the build lease (ESTIMATE_BUILD_LEASE_MS, longer than the function may run)
// has passed — the builder may at once. A DUPLICATE request is answered
// already-applied.
//
// A CONCURRENT BOQ CHANGE never corrupts a revision, wherever it lands. Every
// stored line, total, the source key and the hash are derived from the ONE
// snapshot, in memory, before the claim; nothing after it reads the BOQ. So a
// revision is always exactly "the BOQ whose key it stores" (`sourceKey`, as
// read at `sourceReadAt`): an edit after the snapshot, between chunk writes,
// just before completion or after it is DRIFT — the live key differs from the
// stored key at once, and the page says so. Nothing needs a source comparison
// at completion (there is no claim about the live BOQ to check); the one
// operation that claims the live BOQ IS the approved revision — the ADR-81
// transfer naming an estimate — compares the keys INSIDE its own read-write
// transaction, over the register it reads in it (boqBudget/transfer.js).
// tests/functions/estimating.test.js proves each landing point with hooks.
//
// ── APPROVING (operation `approve`) ──────────────────────────────────────────
//
// One transaction: the caller (company_admin / project_manager), the header
// (state `draft`, the revision AND the content hash the approver reviewed),
// every chunk — the stored content is RE-VERIFIED before it becomes
// authoritative (each line, the chunk fence, the line count, the totals, the
// source key and the SHA-256 are recomputed and must equal the header) — the
// company approval-segregation policy (ADR-96), then: state `approved`, the
// approved-revision pointer, one audit event. An approved revision is never
// written again by any operation; a later revision is a NEW document.
// Approving a draft whose BOQ has since drifted approves the revision as it
// was priced (its key says which BOQ); it never re-prices it.
//
// READS / WRITES (N active items, C chunks; C ≤ ⌈N ÷ 67⌉ whatever the text —
// calc.LINE_MAX_BYTES — and ⌈N ÷ 250⌉ for ordinary text). build: one read-only
// transaction of ~4 + N + (breakdowns) documents, then 1 + ⌈C ÷ CHUNKS_PER_TX⌉
// + 1 small transactions (each chunk transaction ≤ 4 × 402,048 bytes by the
// bound). approve: ~6 documents + C chunks, 3 writes. Measured: TESTING.md §88.6.

export const ESTIMATE_BUILD_LEASE_MS = 180_000
export const CHUNKS_PER_TX = 4
export const CHUNK_DELETES_PER_TX = 100
export const ESTIMATE_MAX_ATTEMPTS = 5
// What the snapshot reads of a BOQ item (calc.buildEstimateLines and the source key).
const BOQ_FIELDS = ['status', 'itemNumber', 'section', 'description', 'unit', 'quantity', 'rate', 'amount', 'currency', 'costCodeId', 'costCodeName']
const GRPC_ABORTED = 10

const S = calc.ESTIMATE_STATE
const withId = (snap) => (snap.exists ? { ...snap.data(), id: snap.id } : null)
const docsOf = (snap) => snap.docs.map(d => ({ id: d.id, ...d.data() }))

function scopeOf(db, companyId, projectId) {
  const companyRef = db.collection('companies').doc(companyId)
  const projectRef = companyRef.collection('projects').doc(projectId)
  return {
    companyId, companyRef, projectRef,
    estimates: projectRef.collection('estimates'),
    inputs: projectRef.collection('estimateItemInputs'),
    boqItems: projectRef.collection('boqItems'),
    stateRef: projectRef.collection('estimateState').doc('current'),
  }
}

// The caller, read inside the transaction; the scope of THE CALLER'S company —
// never the request's — so another tenant's project is simply not found. The
// company's Phase 2 activation is re-read in the same transaction, so a
// deactivation and an operation in flight are ordered by Firestore.
async function callerScope(tx, db, uid, projectId, roles) {
  const profileSnap = await tx.get(userRef(db, uid))
  const profile = assertActiveRole(profileSnap.exists ? profileSnap.data() : null, roles, CODE.ESTIMATE_FORBIDDEN)
  await requireCommercialActivationInTx(tx, db, profile.companyId)
  return { ...scopeOf(db, profile.companyId, projectId), profile }
}

async function guarded(db, body, options = {}) {
  try {
    return await db.runTransaction(body, options.readOnly ? { readOnly: true } : { maxAttempts: ESTIMATE_MAX_ATTEMPTS })
  } catch (err) {
    // ABORTED is the one transport failure with a certain outcome: nothing
    // committed. Anything else untyped is rethrown — its outcome is not certain.
    if (!err?.details?.code && err?.code === GRPC_ABORTED) fail(CODE.ESTIMATE_BUSY)
    throw err
  }
}

function requireRevision(live, expected) {
  const stored = Number.isSafeInteger(live?.revision) ? live.revision : 0
  if (stored !== expected) fail(CODE.ESTIMATE_STALE, { revision: stored })
}

const millisOf = (v) => (typeof v?.toMillis === 'function' ? v.toMillis() : (v instanceof Date ? v.getTime() : null))

// May `uid` start a build over a header that is `building`? Its builder may at
// once (a retry after a failed request); anyone else only after the lease.
function mayTakeOver(header, uid, nowMillis) {
  if (header.runBy === uid) return true
  const started = millisOf(header.runStartedAt)
  return started === null || nowMillis - started > ESTIMATE_BUILD_LEASE_MS
}

export function contentSha256({ currency, settings, totals, lines, sourceKey }) {
  const hash = createHash('sha256')
  hash.update(calc.canonicalHeader({ currency, settings, totals, lineCount: lines.length, sourceKey }))
  for (const line of lines) { hash.update('\n'); hash.update(calc.canonicalLine(line)) }
  return hash.digest('hex')
}

const settingsOf = (header) => calc.normaliseEstimateSettings(Object.fromEntries(calc.ESTIMATE_SETTINGS_KEYS.map(k => [k, header[k]])))
const summaryOf = (header) => ({
  revisionNumber: header.revisionNumber ?? null, number: header.number ?? null, revision: header.revision ?? null,
  state: header.state, lineCount: header.lineCount ?? null, chunkCount: header.chunkCount ?? null,
  contentSha256: header.contentSha256 ?? null, sourceKey: header.sourceKey ?? null,
})

// ── build ────────────────────────────────────────────────────────────────────

export async function buildEstimate(deps, { uid, input, requestId = null }) {
  const { db, now, log, hooks = {}, sourceLimit = calc.ESTIMATE_MAX_ITEMS } = deps
  const { projectId, estimateId, expectedRevision, settings } = input
  const creating = expectedRevision === null
  const requestKey = calc.buildRequestKey(estimateId, expectedRevision, settings)
  const started = Date.now()

  // The header checks shared by the snapshot read and the claim: returns
  // 'applied' for a repeat of a completed request, otherwise refuses or passes.
  const assess = (header) => {
    if (creating) {
      if (!header) return 'new'
      if (header.createdBy !== uid) fail(CODE.ESTIMATE_ID_CONFLICT)
      if (header.state !== S.BUILDING) {
        if (header.createRequestKey === requestKey) return 'applied'
        fail(CODE.ESTIMATE_ID_CONFLICT)
      }
      if (header.createRequestKey !== requestKey) fail(CODE.ESTIMATE_ID_CONFLICT)
    } else {
      if (!header) fail(CODE.NOT_FOUND)
      if (header.state === S.DRAFT && header.requestKey === requestKey && header.updatedBy === uid && header.revision === expectedRevision + 1) return 'applied'
      if (header.state !== S.DRAFT && header.state !== S.BUILDING) fail(CODE.ESTIMATE_INVALID, { reason: 'state', state: header.state ?? null })
      requireRevision(header, expectedRevision)
    }
    if (header.state === S.BUILDING && !mayTakeOver(header, uid, now().getTime())) fail(CODE.ESTIMATE_BUILDING)
    return 'build'
  }

  // 1. The snapshot read — one read time for the caller, the project and the BOQ.
  const sourceReadAt = now()
  const snapshot = await guarded(db, async (tx) => {
    const scope = await callerScope(tx, db, uid, projectId, calc.ESTIMATE_ROLES)
    const estimateRef = scope.estimates.doc(estimateId)
    const [companySnap, projectSnap, headerSnap] = await tx.getAll(scope.companyRef, scope.projectRef, estimateRef)
    if (!companySnap.exists || !projectSnap.exists) fail(CODE.NOT_FOUND)
    const header = withId(headerSnap)
    if (assess(header) === 'applied') return { applied: header }
    // The ACTIVE items only (a void item is not part of an estimate or of its
    // source key), and only the fields a line or the source key uses — an
    // item's notes and other unbounded fields are never read.
    const [boq, inputs] = await Promise.all([
      tx.get(scope.boqItems.where('status', '==', 'active').select(...BOQ_FIELDS).limit(sourceLimit + 1)),
      tx.get(scope.inputs.limit(sourceLimit + 1)),
    ])
    if (boq.size > sourceLimit || inputs.size > sourceLimit) {
      fail(CODE.ESTIMATE_SOURCE_INVALID, { problem: calc.ESTIMATE_PROBLEM.TOO_LARGE, limit: sourceLimit, message: calc.ESTIMATE_PROBLEM_LABELS[calc.ESTIMATE_PROBLEM.TOO_LARGE] })
    }
    const currency = calc.resolveProjectCurrency(withId(projectSnap), withId(companySnap))
    return { scope, currency, boqItems: docsOf(boq), itemInputs: new Map(inputs.docs.map(d => [d.id, d.data()])) }
  }, { readOnly: true })
  if (snapshot.applied) return { id: estimateId, alreadyApplied: true, ...summaryOf(snapshot.applied) }

  // Everything derived and validated BEFORE any write.
  const { scope, currency } = snapshot
  const built = calc.buildEstimateLines({ boqItems: snapshot.boqItems, itemInputs: snapshot.itemInputs, settings, currencyCode: currency })
  if (built.problems.length > 0) {
    fail(CODE.ESTIMATE_SOURCE_INVALID, {
      problem: built.problems[0].kind, problemCounts: built.problemCounts, message: calc.describeEstimateProblems(built),
      items: built.problems.slice(0, calc.PROBLEM_SAMPLE).map(p => ({ kind: p.kind, itemId: p.itemId, itemNumber: p.itemNumber, detail: p.detail })),
    })
  }
  const priced = calc.estimateTotals(built.lines, settings)
  if (priced.problem) fail(CODE.ESTIMATE_INVALID, { reason: priced.kind ?? 'totals', message: priced.problem })
  const { totals } = priced
  const sourceKey = calc.estimateSourceKey(snapshot.boqItems)
  const sha = contentSha256({ currency, settings, totals, lines: built.lines, sourceKey })
  const chunks = calc.chunkEstimateLines(built.lines)
  const estimateRef = scope.estimates.doc(estimateId)
  const runId = randomUUID()
  if (hooks.afterRead) await hooks.afterRead({ lines: built.lines.length, chunks: chunks.length })

  // 2. The claim.
  const claim = await guarded(db, async (tx) => {
    const live = await callerScope(tx, db, uid, projectId, calc.ESTIMATE_ROLES)
    const [headerSnap, stateSnap] = await tx.getAll(estimateRef, live.stateRef)
    const header = withId(headerSnap)
    if (assess(header) === 'applied') return { applied: header }
    const stamp = FieldValue.serverTimestamp()
    const highWater = Math.max(Number.isSafeInteger(header?.chunkHighWater) ? header.chunkHighWater : 0, chunks.length)
    const run = { state: S.BUILDING, runId, runBy: uid, runStartedAt: now(), chunkHighWater: highWater, updatedAt: stamp }
    if (!header) {
      const next = stateSnap.exists && Number.isSafeInteger(stateSnap.data().nextRevisionNumber) ? stateSnap.data().nextRevisionNumber : 1
      if (next < 1 || next > 999_999) fail(CODE.ESTIMATE_INVALID, { reason: 'counter' })
      tx.create(estimateRef, {
        // The authored settings are stored at once, so an interrupted first
        // build can be repeated as the SAME request (createRequestKey).
        ...settings, ...run, revisionNumber: next, number: calc.formatEstimateNumber(next), revision: 0, calcVersion: calc.ESTIMATING_VERSION,
        createRequestKey: requestKey, createdAt: stamp, createdBy: uid, updatedBy: uid, ...createdEditorStamp(uid),
        approvedAt: null, approvedBy: null, discardedAt: null, discardedBy: null, discardReason: '',
      })
      tx.set(live.stateRef, { nextRevisionNumber: next + 1, updatedAt: stamp }, { merge: true })
      return { highWater, revisionNumber: next }
    }
    tx.update(estimateRef, run)
    return { highWater, revisionNumber: header.revisionNumber }
  })
  if (claim.applied) return { id: estimateId, alreadyApplied: true, ...summaryOf(claim.applied) }
  if (hooks.afterClaim) await hooks.afterClaim({ runId })

  // 3. The chunks, each write fenced by the run id.
  const fenced = (body) => guarded(db, async (tx) => {
    const header = withId(await tx.get(estimateRef))
    if (!header || header.state !== S.BUILDING || header.runId !== runId) fail(CODE.ESTIMATE_SUPERSEDED)
    return body(tx, header)
  })
  const lineRefs = estimateRef.collection('lines')
  let written = 0
  for (let i = 0; i < chunks.length; i += CHUNKS_PER_TX) {
    const group = chunks.slice(i, i + CHUNKS_PER_TX)
    await fenced(async (tx) => {
      group.forEach((lines, k) => tx.set(lineRefs.doc(calc.chunkDocId(i + k)), { index: i + k, count: lines.length, runId, lines }))
    })
    written += group.length
    if (hooks.afterChunkGroup) await hooks.afterChunkGroup({ written, total: chunks.length, runId })
  }
  for (let i = chunks.length; i < claim.highWater; i += CHUNK_DELETES_PER_TX) {
    const end = Math.min(claim.highWater, i + CHUNK_DELETES_PER_TX)
    await fenced(async (tx) => { for (let k = i; k < end; k += 1) tx.delete(lineRefs.doc(calc.chunkDocId(k))) })
  }

  // 4. Completion — the only step that makes the revision a reviewable draft.
  //    It writes what the snapshot read produced and compares no live source:
  //    the revision claims to be the BOQ whose key it stores (see the header).
  if (hooks.beforeComplete) await hooks.beforeComplete({ runId, contentSha256: sha })
  const done = await guarded(db, async (tx) => {
    const live = await callerScope(tx, db, uid, projectId, calc.ESTIMATE_ROLES)
    const header = withId(await tx.get(estimateRef))
    if (!header || header.state !== S.BUILDING || header.runId !== runId) fail(CODE.ESTIMATE_SUPERSEDED)
    const stamp = FieldValue.serverTimestamp()
    const revision = (Number.isSafeInteger(header.revision) ? header.revision : 0) + 1
    const content = {
      ...settings, currency, totals, lineCount: built.lines.length, chunkCount: chunks.length,
      sourceKey, contentSha256: sha,
    }
    // ADR-96 (D4): the last MATERIAL editor is the user whose build changed
    // the content hash — every line, total, pricing assumption and the source
    // key are under it; the title and the notes are not. A rebuild that changes
    // only those leaves the stamp with whoever last changed a figure.
    tx.update(estimateRef, {
      ...content, state: S.DRAFT, chunkHighWater: chunks.length, sourceReadAt, revision, requestKey,
      updatedAt: stamp, updatedBy: uid, ...editorStamp(header, uid, { contentSha256: sha }),
    })
    auditInTx(tx, db, live.companyId, {
      type: AUDIT.ESTIMATE_BUILT, actorUid: uid, requestId,
      before: { revision: header.revision ?? 0 },
      after: {
        projectId, estimateId, revisionNumber: header.revisionNumber, revision, currency,
        lineCount: built.lines.length, chunkCount: chunks.length, sourceKey, contentSha256: sha,
        pricingPolicy: settings.pricingPolicy, pricingBps: settings.pricingBps,
        costTotalCents: totals.costTotalCents, sellCents: totals.sellCents,
      },
    }, now())
    return { revision, revisionNumber: header.revisionNumber, number: header.number }
  })
  log.info('estimate built', { uid, projectId, estimateId, lines: built.lines.length, chunks: chunks.length, ms: Date.now() - started })
  return {
    id: estimateId, alreadyApplied: false, state: S.DRAFT, ...done,
    lineCount: built.lines.length, chunkCount: chunks.length, contentSha256: sha, sourceKey,
  }
}

// ── approve ──────────────────────────────────────────────────────────────────

// Every chunk of a header, verified against it; returns the lines or refuses.
function verifiedLines(header, chunkSnaps) {
  const lines = []
  chunkSnaps.forEach((snap, i) => {
    const chunk = snap.exists ? snap.data() : null
    if (!chunk || chunk.index !== i || chunk.runId !== header.runId || !Array.isArray(chunk.lines) || chunk.lines.length !== chunk.count) {
      fail(CODE.ESTIMATE_INCONSISTENT, { reason: 'chunk', index: i })
    }
    for (const line of chunk.lines) {
      const problem = calc.storedLineProblem(line)
      if (problem) fail(CODE.ESTIMATE_INCONSISTENT, { reason: 'line', message: problem })
      lines.push(line)
    }
  })
  return lines
}

export async function approveEstimate(deps, { uid, input, requestId = null }) {
  const { db, now, log } = deps
  const { projectId, estimateId, expectedRevision } = input
  const result = await guarded(db, async (tx) => {
    const scope = await callerScope(tx, db, uid, projectId, calc.ESTIMATE_APPROVER_ROLES)
    const estimateRef = scope.estimates.doc(estimateId)
    const [projectSnap, headerSnap, stateSnap] = await tx.getAll(scope.projectRef, estimateRef, scope.stateRef)
    if (!projectSnap.exists || !headerSnap.exists) fail(CODE.NOT_FOUND)
    const header = withId(headerSnap)
    const segregation = segregationGuard(db, uid, { label: 'estimate revision' })
    await segregation.read(tx, scope)
    if (header.state === S.APPROVED && header.approvedBy === uid && header.revision === expectedRevision + 1) return { alreadyApplied: true, header }
    if (header.state === S.BUILDING) fail(CODE.ESTIMATE_BUILDING)
    if (header.state !== S.DRAFT) fail(CODE.ESTIMATE_INVALID, { reason: 'state', state: header.state ?? null })
    requireRevision(header, expectedRevision)
    if (header.contentSha256 !== input.contentSha256) fail(CODE.ESTIMATE_STALE, { reason: 'content' })

    // The stored content, re-verified before it becomes authoritative.
    const chunkCount = Number.isSafeInteger(header.chunkCount) ? header.chunkCount : -1
    if (chunkCount < 1) fail(CODE.ESTIMATE_INCONSISTENT, { reason: 'chunk-count' })
    const refs = Array.from({ length: chunkCount }, (_, i) => estimateRef.collection('lines').doc(calc.chunkDocId(i)))
    const lines = verifiedLines(header, await tx.getAll(...refs))
    const settingsProblem = calc.estimateSettingsProblem(Object.fromEntries(calc.ESTIMATE_SETTINGS_KEYS.map(k => [k, header[k]])))
    if (settingsProblem) fail(CODE.ESTIMATE_INCONSISTENT, { reason: 'settings', message: settingsProblem })
    const settings = settingsOf(header)
    const classOf = new Map(settings.costCodeClasses.map(c => [c.costCodeId, c.costClass]))
    if (lines.length !== header.lineCount || lines.length === 0) fail(CODE.ESTIMATE_INCONSISTENT, { reason: 'line-count' })
    if (lines.some(l => l.costClass !== (classOf.get(l.costCodeId) ?? calc.COST_CLASS.DIRECT))) fail(CODE.ESTIMATE_INCONSISTENT, { reason: 'class' })
    const priced = calc.estimateTotals(lines, settings)
    if (priced.problem || !calc.sameTotals(header.totals, priced.totals)) fail(CODE.ESTIMATE_INCONSISTENT, { reason: 'totals' })
    if (calc.sourceKeyOfLines(lines) !== header.sourceKey) fail(CODE.ESTIMATE_INCONSISTENT, { reason: 'source-key' })
    const sha = contentSha256({ currency: header.currency, settings, totals: priced.totals, lines, sourceKey: header.sourceKey })
    if (sha !== header.contentSha256) fail(CODE.ESTIMATE_INCONSISTENT, { reason: 'content' })

    segregation.check(header)

    const stamp = FieldValue.serverTimestamp()
    const revision = header.revision + 1
    tx.update(estimateRef, { state: S.APPROVED, approvedAt: stamp, approvedBy: uid, revision, updatedAt: stamp, updatedBy: uid })
    const state = stateSnap.exists ? stateSnap.data() : {}
    if (!Number.isSafeInteger(state.approvedRevisionNumber) || header.revisionNumber > state.approvedRevisionNumber) {
      tx.set(scope.stateRef, { approvedEstimateId: estimateId, approvedRevisionNumber: header.revisionNumber, updatedAt: stamp }, { merge: true })
    }
    auditInTx(tx, db, scope.companyId, {
      type: AUDIT.ESTIMATE_APPROVED, actorUid: uid, requestId,
      before: { state: S.DRAFT, revision: header.revision },
      after: {
        projectId, estimateId, revisionNumber: header.revisionNumber, revision, currency: header.currency,
        lineCount: lines.length, sourceKey: header.sourceKey, contentSha256: sha,
        pricingPolicy: settings.pricingPolicy, pricingBps: settings.pricingBps,
        overheadMode: settings.overheadMode, overheadBps: settings.overheadBps,
        contingencyMode: settings.contingencyMode, contingencyBps: settings.contingencyBps,
        ...Object.fromEntries(['directCents', 'preliminariesCents', 'overheadCents', 'contingencyCents', 'costTotalCents', 'sellCents', 'grossProfitCents'].map(k => [k, priced.totals[k]])),
        segregation: segregation.record(),
      },
    }, now())
    return { alreadyApplied: false, header: { ...header, state: S.APPROVED, revision } }
  })
  log.info('estimate approve', { uid, projectId, estimateId, alreadyApplied: result.alreadyApplied })
  return { id: estimateId, alreadyApplied: result.alreadyApplied, ...summaryOf(result.header) }
}

// ── discard ──────────────────────────────────────────────────────────────────

export async function discardEstimate(deps, { uid, input, requestId = null }) {
  const { db, now, log } = deps
  const { projectId, estimateId, expectedRevision } = input
  const result = await guarded(db, async (tx) => {
    const scope = await callerScope(tx, db, uid, projectId, calc.ESTIMATE_ROLES)
    const estimateRef = scope.estimates.doc(estimateId)
    const headerSnap = await tx.get(estimateRef)
    if (!headerSnap.exists) fail(CODE.NOT_FOUND)
    const header = withId(headerSnap)
    if (header.state === S.DISCARDED && header.discardedBy === uid) return { alreadyApplied: true, header }
    // An approved revision is permanent; so is one already discarded by another.
    if (header.state !== S.DRAFT && header.state !== S.BUILDING) fail(CODE.ESTIMATE_INVALID, { reason: 'state', state: header.state ?? null })
    requireRevision(header, expectedRevision)
    if (header.state === S.BUILDING && !mayTakeOver(header, uid, now().getTime())) fail(CODE.ESTIMATE_BUILDING)
    const stamp = FieldValue.serverTimestamp()
    const revision = (Number.isSafeInteger(header.revision) ? header.revision : 0) + 1
    // A new run id stops any build still writing chunks for this header.
    tx.update(estimateRef, { state: S.DISCARDED, runId: randomUUID(), discardedAt: stamp, discardedBy: uid, discardReason: input.reason, revision, updatedAt: stamp, updatedBy: uid })
    auditInTx(tx, db, scope.companyId, {
      type: AUDIT.ESTIMATE_DISCARDED, actorUid: uid, requestId,
      before: { state: header.state, revision: header.revision ?? 0 },
      after: { projectId, estimateId, revisionNumber: header.revisionNumber, revision, reason: input.reason },
    }, now())
    return { alreadyApplied: false, header: { ...header, state: S.DISCARDED, revision } }
  })
  log.info('estimate discard', { uid, projectId, estimateId, alreadyApplied: result.alreadyApplied })
  return { id: estimateId, alreadyApplied: result.alreadyApplied, ...summaryOf(result.header) }
}

// ── setComponents ────────────────────────────────────────────────────────────
//
// The optional labour / material / plant / subcontractor breakdown of BOQ unit
// rates — estimate INPUT, not a cost: it must add up to the item's unit rate
// when it is saved, and is re-checked against the rate whenever a revision is
// built (a rate changed since refuses the build, naming the item). It changes
// no stored revision and writes no audit event (a draft input, as a draft edit).

export async function setEstimateComponents(deps, { uid, input }) {
  const { db, log } = deps
  const result = await guarded(db, async (tx) => {
    const scope = await callerScope(tx, db, uid, input.projectId, calc.ESTIMATE_ROLES)
    const projectSnap = await tx.get(scope.projectRef)
    if (!projectSnap.exists) fail(CODE.NOT_FOUND)
    const ids = input.items.map(i => i.boqItemId)
    const snaps = await tx.getAll(...ids.flatMap(id => [scope.boqItems.doc(id), scope.inputs.doc(id)]))
    const stamp = FieldValue.serverTimestamp()
    let changed = 0
    input.items.forEach((it, n) => {
      const item = withId(snaps[2 * n])
      const stored = snaps[2 * n + 1].exists ? snaps[2 * n + 1].data() : null
      const ref = scope.inputs.doc(it.boqItemId)
      if (it.components === null) {
        if (stored) { tx.delete(ref); changed += 1 }
        return
      }
      if (!item || item.status !== 'active') fail(CODE.ESTIMATE_INVALID, { reason: 'item', itemId: it.boqItemId, message: 'A rate breakdown can only be attached to an active BOQ item.' })
      const problem = calc.componentsProblem(it.components, item.rate)
      if (problem) fail(CODE.ESTIMATE_INVALID, { reason: 'components', itemId: it.boqItemId, itemNumber: item.itemNumber ?? '', message: `${item.itemNumber || 'An item'}: ${problem}` })
      if (stored && calc.COMPONENT_KEYS.every(k => stored.components?.[k] === it.components[k]) && stored.rate === item.rate) return
      tx.set(ref, { components: it.components, rate: item.rate, updatedAt: stamp, updatedBy: uid })
      changed += 1
    })
    return { alreadyApplied: changed === 0, changed }
  })
  log.info('estimate components', { uid, projectId: input.projectId, items: input.items.length, changed: result.changed })
  return result
}
