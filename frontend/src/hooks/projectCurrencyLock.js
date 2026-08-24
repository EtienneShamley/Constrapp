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
//
// WHY THIS WRITES `currencyLocked` ALONE and does NOT also pin `currency`.
// A project can end up locked with no stored currency, and `useProjects.
// lockProjectCurrency` repairs that by pinning both keys together (see
// `lib/currency.js → currencyToPinOnLock`). This path deliberately does not,
// for two reasons that both point the same way:
//   · SAME NARROW QS RULE. A two-key diff fails `hasOnly(['currencyLocked'])`,
//     so every QS budget line, PO, claim, invoice, variation, forecast input,
//     BOQ item, receipt, payment, credit note and cash-flow line on such a
//     project would be REJECTED IN FULL. That trades a display label for a
//     broken commercial workflow.
//   · IT WOULD ADD NO COVERAGE. `currencyToPinOnLock` returns null while the
//     company has no configured base currency, because the AUD display fallback
//     is nobody's decision and freezing it through a one-way ratchet would make
//     a possibly-wrong label permanent. An unpinned project is precisely a
//     project from a company that has not completed currency setup (every
//     project created since carries an explicit currency, and Company Settings
//     pins the rest on save) — so the pin this path could offer would be null
//     for the entire population it would apply to.
// The state therefore remains reachable here BY DESIGN, and is repairable:
// Firestore rules allow a locked project holding no well-formed currency to
// receive its FIRST explicit code (see firestore.rules → LEGACY
// INITIALISATION), which is what Company Settings writes.
export async function stageProjectCurrencyLock(tx, companyId, projectId) {
  const ref = doc(db, 'companies', companyId, 'projects', projectId)
  const snap = await tx.get(ref)
  if (!snap.exists() || snap.data().currencyLocked === true) return () => {}
  return () => tx.update(ref, { currencyLocked: true })
}
