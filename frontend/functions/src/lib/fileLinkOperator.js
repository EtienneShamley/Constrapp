import { inventoryCompany } from './fileLinkTokens.js'
import { stateRef, requestRevocation, processCompany } from './fileLinkRevocation.js'
import { toIso } from './membershipState.js'

// ── Operator run of the file-link revocation (ADR-74) — injected, testable ───
//
// The body of scripts/revoke-file-links.mjs, with Firestore, the bucket, the
// clock, the output and the wait all injected so the whole decision path is
// tested against the emulator with a fake bucket.
//
//   execute === false  READ ONLY: an inventory and the current state.
//   execute === true   a revocation REQUEST plus the SAME sweep the scheduled
//                      worker runs (same lease, checkpoints and audit events).
//
// Output is counts and ids. A token value never reaches `out`.

const realSleep = (ms) => new Promise((r) => setTimeout(r, ms))

export async function runOperator({ db, bucket, now, out, sleep = realSleep }, { companyIds, execute = false, owner, maxMs = 30 * 60 * 1000, sweepOptions = {} }) {
  const deadline = now().getTime() + maxMs
  const quiet = { info() {}, warn: (m, f) => out.warn(`${m} ${JSON.stringify(f ?? {})}`), error: (m, f) => out.error(`${m} ${JSON.stringify(f ?? {})}`) }
  const summary = []

  for (const companyId of companyIds) {
    const before = await inventoryCompany(bucket, companyId)
    const snap = await stateRef(db, companyId).get()
    const st = snap.exists ? snap.data() : {}
    out.info(`  ${companyId}: ${before.scanned} object(s), ${before.withToken} with a download token · requests ${st.requestSeq ?? 0}, completed ${st.completedSeq ?? 0}`
      + `${st.completedAt ? ` (last ${toIso(st.completedAt)})` : ''}${(st.consecutiveIncomplete ?? 0) > 0 ? ` · ${st.consecutiveIncomplete} incomplete sweep(s)` : ''}`)
    if (!execute) { summary.push({ companyId, ...before, executed: false, complete: null }); continue }

    const seq = await requestRevocation({ db, now }, { companyId })
    let complete
    let last
    for (;;) {
      last = await processCompany({ db, bucket, now, log: quiet }, companyId, { owner, sweepOptions })
      complete = ((await stateRef(db, companyId).get()).data()?.completedSeq ?? 0) >= seq
      if (complete) { out.info(`       → complete: ${last.scanned ?? 0} scanned, ${last.removed ?? 0} token(s) removed, 0 failed`); break }
      if (last.action === 'incomplete' || last.action === 'backoff') {
        out.warn(`       → NOT complete: ${last.failed ?? 'some'} object(s) failed. Old links for those objects may still work. The request stays queued and is retried automatically.`)
        break
      }
      if (now().getTime() >= deadline) {
        out.warn(`       → NOT complete (${last.action}). The request stays queued; the scheduled worker or a re-run continues it.`)
        break
      }
      // busy = the scheduled worker holds the lease; error/yielded = resume.
      out.info(`       … ${last.action}; waiting`)
      await sleep(last.action === 'busy' ? 15000 : 5000)
    }
    summary.push({ companyId, ...before, executed: true, complete, removed: last?.removed ?? 0, failed: last?.failed ?? 0 })
  }
  return summary
}
