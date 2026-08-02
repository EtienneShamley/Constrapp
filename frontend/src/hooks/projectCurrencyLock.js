import { doc } from 'firebase/firestore'
import { db } from '../lib/firebase'

// ── Atomic project currency ratchet ──────────────────────────────────────────
//
// Every write that puts MONETARY data on a project must engage
// `project.currencyLocked` in the SAME Firestore transaction as the record
// itself. If the record could commit while the lock write failed separately,
// the project would hold amounts while its currency stayed changeable — and
// changing it then RELABELS those amounts without converting them, which is the
// precise harm the ratchet exists to prevent. Record and lock now succeed or
// fail together.
//
// Usage inside `runTransaction`:
//
//   await runTransaction(db, async (tx) => {
//     const counterSnap = await tx.get(counterRef)              // reads…
//     const commitLock  = await stageProjectCurrencyLock(tx, companyId, projectId)
//     tx.set(docRef, { … })                                     // …then writes
//     commitLock()
//   })
//
// Firestore requires ALL transaction reads before ANY writes, so this is split
// into a read phase (this function) and a write phase (the returned callback).
//
// The lock write is staged ONLY when the project exists and is not already
// locked. That matters for more than write cost: the `qs` role holds a
// deliberately narrow rule permitting `currencyLocked` false → true and nothing
// else, so an unconditional re-write of `true` on an already-locked project
// would be REJECTED and would fail the whole financial write for a QS user.
// Returning a no-op keeps already-locked projects untouched.
export async function stageProjectCurrencyLock(tx, companyId, projectId) {
  const ref = doc(db, 'companies', companyId, 'projects', projectId)
  const snap = await tx.get(ref)
  if (!snap.exists() || snap.data().currencyLocked === true) return () => {}
  return () => tx.update(ref, { currencyLocked: true })
}
