import { FieldValue } from '../lib/firebaseAdmin.js'
import { CODE, fail } from '../lib/errors.js'
import { AUDIT, auditInTx } from '../lib/audit.js'
import * as calc from '../generated/supplierFinanceCalc.js'
import { createHash, randomUUID } from 'node:crypto'
import { userRef, assertActiveRole } from '../lib/authz.js'
import { projectScope, withId, SUPPLIER_FINANCE_ROLES } from './context.js'

// ── The historical supplier-finance baseline (ADR-94) ────────────────────────
//
// The ledgers are EXACT only if they account for every posted credit note,
// retention release, payment allocation and certified claim that existed
// before posting became a backend operation. So, ONCE per project:
//
//   companies/{c}/projects/{p}/supplierFinanceState/baseline   (the marker)
//
// is written after every ledger the history implies has been created:
//   · supplierInvoiceLedgers/{invoiceId} — per invoice any POSTED credit,
//     release or payment allocation names: the stored figures summed, with a
//     permanent `baseline` record (sources counted) and a `state`:
//     'established', or 'inconsistent' with the reason (an over-release, an
//     over-credit, a credit on a cost code the invoice does not carry, an
//     invoice that does not reconcile with itself, an entry naming no
//     existing invoice). An inconsistent ledger refuses every POSTING on its
//     invoice until voids bring it back within its invariants; it is never
//     clamped, never repaired;
//   · poClaimLedgers/{poId} — per PO any open or certified claim names: the
//     open claims and the certified amounts per PO line / variation line;
//     inconsistent when several claims are open on one PO (DC36) or a
//     certified figure is malformed.
// A POSTED payment whose allocations cannot be attributed to an invoice (not a
// list, no invoice id, a non-positive or fraction-of-a-cent amount) refuses the
// WHOLE baseline, naming it — never skipped, so no sum can be short — and
// nothing is written.
//
// States (ADR-94): NO BASELINE (marker absent, or present and still
// `building` — every operation refuses; neither is ever read as zero) ·
// ESTABLISHED ZERO (marker `complete`, ledger absent or all zero) ·
// ESTABLISHED NON-ZERO · INCONSISTENT (per ledger, above) · MISSING SOURCE
// (the whole-baseline refusal, above).
//
// ── THE CONSISTENCY PROTOCOL ─────────────────────────────────────────────────
//
// Chunked writes are not atomic, so nothing here relies on them being so. The
// ledgers become AUTHORITATIVE in one transaction — the completion — and only
// if all of the following held:
//
//  1. OWNERSHIP (the run fence). A run first claims the marker in a
//     transaction: `{ state: 'building', runId, leaseUntilMillis }`. Every
//     ledger write of the run is a transaction that re-reads the marker and
//     writes only while it is still `building` under THIS runId. A second
//     request arriving meanwhile is refused (`supplier-finance-busy`, nothing
//     written) until the lease — longer than a function may run — expires;
//     after that it TAKES OVER with a new runId, and every write the old run
//     still attempts is refused by the fence.
//  2. ONE SNAPSHOT. The five registers are read in ONE read-only transaction —
//     a single consistent point in time — never as five separate queries.
//  3. NO INHERITED STATE. A run writes every ledger it computed (overwriting
//     what an interrupted run left) and deletes any ledger document it did not
//     compute. So the ledger set at completion is exactly this run's — an
//     interrupted run can leave nothing behind, duplicated or stale.
//  4. THE SOURCE FENCE. A digest of the snapshot (every register document's
//     path and update time) is taken at the read and taken AGAIN INSIDE the
//     completion transaction (5), through that transaction's own reads of the
//     five registers. If any register document was created, changed or deleted
//     since the snapshot, the run abandons in that same transaction: the
//     marker is released, nothing is authoritative, the caller is told to
//     retry. A write racing the completion conflicts with it and is ordered
//     either before it (detected) or after it.
//  5. COMPLETION. One transaction: the marker is still this run's; the caller
//     is STILL an active member in an authorised role (a member revoked during
//     the run completes nothing); the marker becomes `complete` carrying the
//     source digest, the digest of the ledger set, and the counts; one audit
//     event. `scripts`/tests can recompute both digests from the registers.
//
// The fence and the completion are one transaction, so there is no interval
// between them. Independently of that, the history cannot move financially
// during a run: no client can write these registers' financial content
// (Firestore Rules — the one remaining client write, a claim's submission,
// changes neither an open claim's identity nor any certified figure, but it
// DOES change the document's update time and so abandons a racing run), and
// every backend operation refuses, inside its own transaction, until the
// marker is `complete`.
//
// A posting therefore never sees a partial baseline: it reads the marker in
// its transaction and proceeds only on `complete`.
//
// COST (one-time, per project; measured in tests/functions/supplierFinance):
// reads = 2 × every register document (the snapshot and the fence) + the
// existing ledger ids; writes = one per ledger, in transactions of at most
// BASELINE_CHUNK. Ordinary postings afterwards read a fixed handful of
// documents and never the registers.


export const BASELINE_CHUNK = 200
// Longer than the callable may run (120 s), so a live run is never taken over.
export const BASELINE_LEASE_MS = 150_000

const sha = (lines) => createHash('sha256').update(lines.join('\n')).digest('hex')
const canonical = (v) => (v === null || typeof v !== 'object' ? JSON.stringify(v ?? null)
  : Array.isArray(v) ? `[${v.map(canonical).join(',')}]`
    : `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`)

const REGISTERS = ['invoices', 'credits', 'releases', 'payments', 'claims']

// ONE consistent snapshot of the five registers, and its digest.
// The five registers read through `tx`, and their digest (every document's
// path and update time). Used for the snapshot AND, inside the completion
// transaction, for the final fence.
async function readRegisters(tx, scope) {
  const snaps = await Promise.all(REGISTERS.map(r => tx.get(scope[r])))
  const out = {}
  const lines = []
  REGISTERS.forEach((r, i) => {
    out[r] = snaps[i].docs
    for (const d of snaps[i].docs) lines.push(`${d.ref.path}@${d.updateTime.seconds}.${d.updateTime.nanoseconds}`)
  })
  out.sourceDigest = sha(lines.sort())
  return out
}

async function readHistory(db, scope) {
  return db.runTransaction(tx => readRegisters(tx, scope), { readOnly: true })
}

// The digest of a ledger set, independent of write order and of stamps.
export function ledgerSetDigest(writes) {
  return sha(writes.map(w => `${w.ref.path}=${canonical(w.figures)}`).sort())
}

async function fenced(db, scope, runId, body) {
  return db.runTransaction(async (tx) => {
    const marker = await tx.get(scope.baselineRef)
    if (!marker.exists || marker.data().state !== 'building' || marker.data().runId !== runId) return { lost: true }
    return { lost: false, value: await body(tx, marker) }
  })
}

const lostRun = () => fail(CODE.SF_BUSY, { reason: 'baseline-superseded', message: 'Another request took over establishing this project’s supplier-finance baseline. Nothing was saved by this request — try again in a moment.' })

export async function ensureSupplierBaseline(deps, { uid, companyId, projectId, requestId = null }) {
  const { db, now, log } = deps
  const clock = deps.clock ?? Date.now
  const scope = projectScope(db, companyId, projectId)
  const first = await scope.baselineRef.get()
  if (first.exists && first.data().state === 'complete') return { established: false }

  // 1. Claim the run.
  const runId = randomUUID()
  const claimed = await db.runTransaction(async (tx) => {
    const [marker, project] = await tx.getAll(scope.baselineRef, scope.projectRef)
    if (!project.exists) return 'no-project'
    const m = marker.exists ? marker.data() : null
    if (m?.state === 'complete') return 'complete'
    if (m?.state === 'building' && Number(m.leaseUntilMillis) > clock()) return 'busy'
    tx.set(scope.baselineRef, {
      state: 'building', runId, startedBy: uid, startedAtMillis: clock(), leaseUntilMillis: clock() + BASELINE_LEASE_MS,
      attempt: (Number.isSafeInteger(m?.attempt) ? m.attempt : 0) + 1,
    })
    return 'claimed'
  })
  if (claimed === 'no-project') fail(CODE.NOT_FOUND)
  if (claimed === 'complete') return { established: false }
  if (claimed === 'busy') {
    fail(CODE.SF_BUSY, { reason: 'baseline-in-progress', message: 'This project’s supplier-finance history is being prepared by another request. Nothing was saved — try again in a moment.' })
  }
  const release = () => fenced(db, scope, runId, async (tx) => { tx.delete(scope.baselineRef) })

  // 2. One consistent snapshot; the ledgers it implies.
  const history = await readHistory(db, scope)
  const invoiceMap = new Map(history.invoices.map(d => [d.id, withId(d)]))
  const settlement = calc.supplierLedgersFromHistory({
    invoices: invoiceMap,
    creditNotes: history.credits.map(withId), releases: history.releases.map(withId), payments: history.payments.map(withId),
  })
  const claimLedgers = settlement.problem ? null : calc.poClaimLedgersFromHistory(history.claims.map(withId))
  const missingSource = settlement.problem ?? claimLedgers.problem
  if (missingSource) {
    await release()
    fail(CODE.SF_BASELINE_INVALID, { message: missingSource })
  }

  const stamp = FieldValue.serverTimestamp()
  const writes = [
    ...[...settlement.ledgers].map(([invoiceId, e]) => {
      const figures = { ...calc.supplierLedgerDocument(e.ledger), invoiceId, state: e.state, problem: e.problem, malformedEntryIds: e.malformedEntryIds, malformedOverflow: e.malformedOverflow, version: calc.SUPPLIER_LEDGER_VERSION, sources: e.sources }
      const { sources, ...doc } = figures
      return { ref: scope.invoiceLedgers.doc(invoiceId), figures, doc: { ...doc, baseline: { version: calc.SUPPLIER_LEDGER_VERSION, sources, runId, establishedAt: stamp }, updatedAt: stamp } }
    }),
    ...[...claimLedgers.ledgers].map(([poId, e]) => {
      const figures = { ...calc.poClaimLedgerDocument(e.ledger), poId, state: e.state, problem: e.problem, problemKind: e.problemKind, sources: e.sources }
      const { sources, ...doc } = figures
      return { ref: scope.poClaimLedgers.doc(poId), figures, doc: { ...doc, baseline: { sources, runId, establishedAt: stamp }, updatedAt: stamp } }
    }),
  ]
  const ledgerDigest = ledgerSetDigest(writes)

  // 3. Write this run's ledgers; remove any it did not compute. Every write fenced.
  const computed = new Set(writes.map(w => w.ref.path))
  const [oldInvoiceLedgers, oldClaimLedgers] = await Promise.all([scope.invoiceLedgers.select().get(), scope.poClaimLedgers.select().get()])
  const stale = [...oldInvoiceLedgers.docs, ...oldClaimLedgers.docs].map(d => d.ref).filter(ref => !computed.has(ref.path))
  const steps = [...writes.map(w => ({ ref: w.ref, doc: w.doc })), ...stale.map(ref => ({ ref, doc: null }))]
  for (let i = 0; i < steps.length; i += BASELINE_CHUNK) {
    const chunk = steps.slice(i, i + BASELINE_CHUNK)
    const done = await fenced(db, scope, runId, async (tx) => {
      for (const w of chunk) { if (w.doc) tx.set(w.ref, w.doc); else tx.delete(w.ref) }
    })
    if (done.lost) lostRun()
    if (deps.afterBaselineChunk) await deps.afterBaselineChunk({ index: i / BASELINE_CHUNK, runId })
  }

  // 4 + 5. The source fence and the completion — ONE transaction, the only
  // moment the ledgers become authoritative. The five registers are read
  // through the completing transaction itself: a source write that commits
  // after these reads conflicts with the transaction (which then re-runs, reads
  // the changed register, sees the digest differ and abandons), and one that
  // commits after the completion is ordered after it. So no source can change
  // between the final digest and the marker becoming `complete` unseen
  // (final release batch, finding 4 — the digest used to be taken in a separate
  // read before this transaction).
  const counts = {
    invoiceLedgers: settlement.ledgers.size,
    invoiceLedgersInconsistent: [...settlement.ledgers.values()].filter(e => e.state === 'inconsistent').length,
    poClaimLedgers: claimLedgers.ledgers.size,
    poClaimLedgersInconsistent: [...claimLedgers.ledgers.values()].filter(e => e.state === 'inconsistent').length,
    invoices: history.invoices.length, creditNotes: history.credits.length, releases: history.releases.length, payments: history.payments.length, claims: history.claims.length,
    staleLedgersRemoved: stale.length,
  }
  let completed
  try {
  completed = await fenced(db, scope, runId, async (tx, marker) => {
    const final = await readRegisters(tx, scope)
    if (deps.afterFinalDigest) await deps.afterFinalDigest({ runId })
    if (final.sourceDigest !== history.sourceDigest) {
      tx.delete(scope.baselineRef)
      return { sourceChanged: true }
    }
    // A caller revoked during the run completes nothing (the run is released below).
    const profileSnap = await tx.get(userRef(db, uid))
    const profile = assertActiveRole(profileSnap.exists ? profileSnap.data() : null, SUPPLIER_FINANCE_ROLES, CODE.SUPPLIER_FINANCE_FORBIDDEN)
    if (profile.companyId !== companyId) fail(CODE.SUPPLIER_FINANCE_FORBIDDEN)
    tx.set(scope.baselineRef, {
      state: 'complete', version: calc.SUPPLIER_LEDGER_VERSION, runId, attempt: marker.data().attempt ?? 1,
      establishedAt: stamp, establishedBy: uid, counts, sourceDigest: history.sourceDigest, ledgerDigest,
    })
    auditInTx(tx, db, companyId, {
      type: AUDIT.SUPPLIER_BASELINE_ESTABLISHED, actorUid: uid, requestId, before: null,
      after: { projectId, ...counts, sourceDigest: history.sourceDigest, ledgerDigest, attempt: marker.data().attempt ?? 1 },
    }, now())
    return { sourceChanged: false }
  })
  } catch (err) {
    await release().catch(() => {})
    throw err
  }
  if (completed.lost) lostRun()
  if (completed.value?.sourceChanged) {
    fail(CODE.SF_BUSY, { reason: 'baseline-source-changed', message: 'Project records changed while the supplier-finance history was being prepared. Nothing was saved — try again.' })
  }
  log.info('supplier-finance baseline', { uid, projectId, established: true, ledgers: writes.length, ...counts })
  return { established: true, counts, sourceDigest: history.sourceDigest, ledgerDigest }
}
