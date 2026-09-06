import { useEffect, useState, useCallback } from 'react'
import { collection, doc, onSnapshot, runTransaction, updateDoc, serverTimestamp, query, orderBy } from 'firebase/firestore'
import { db } from '../lib/firebase'
import { useAuth } from './useAuth'
import { useCompany } from './useCompany'
import { stageProjectCurrencyLock } from './projectCurrencyLock'
import { buildBudgetLineFields, validateBudgetLine } from '../lib/budgetLines'

export function useBudgetLines(projectId) {
  const { user }    = useAuth()
  const { company } = useCompany()
  // Live subscription state, tagged with the target (`key`) it belongs to —
  // the keyed-snapshot pattern used by useProjectActivities / useDrawings. The
  // effect is subscription-only: state is written ONLY from the async
  // onSnapshot callbacks, never synchronously in the effect body, so
  // budgetLines/loading/error are DERIVED at render time below
  // (react-hooks/set-state-in-effect).
  //
  // `error` is true when the live read failed (connection loss or a rules
  // rejection). Consumers deriving financial figures MUST treat a failed read
  // as UNAVAILABLE — never as a genuine zero. It is exposed only once the
  // CURRENT target has settled, so a project switch never flashes a stale
  // unavailable banner under the new project.
  const [snap, setSnap] = useState({ key: null, budgetLines: [], error: false })

  const companyId = company?.id ?? null

  useEffect(() => {
    if (!companyId || !projectId) return undefined

    const key = `${companyId}/${projectId}`
    const ref = collection(db, 'companies', companyId, 'projects', projectId, 'budgetLines')
    const q   = query(ref, orderBy('createdAt', 'desc'))

    const unsubscribe = onSnapshot(
      q,
      (querySnap) => setSnap({
        key,
        budgetLines: querySnap.docs.map(d => ({ id: d.id, ...d.data() })),
        error: false,
      }),
      // A failed read must NOT look like an empty register — "none" and "we
      // could not load them" are opposite facts, and confusing them on a
      // financial register fabricates a zero.
      () => setSnap({ key, budgetLines: [], error: true }),
    )
    return unsubscribe
  }, [companyId, projectId])

  // Derived, at render time: no synchronous setState in the effect. With no
  // target we are idle (no data, not loading); with a target we are loading
  // until the subscription reports for THAT target (`settled`), which also
  // hides the previous project's rows immediately.
  const targetKey = companyId && projectId ? `${companyId}/${projectId}` : null
  const settled = targetKey !== null && snap.key === targetKey
  const budgetLines = settled ? snap.budgetLines : []
  const budgetLinesLoading = targetKey !== null && !settled
  const budgetLinesError = settled ? snap.error : false

  const createBudgetLine = useCallback(async ({ costCodeId, costCodeName, budgeted, notes }) => {
    if (!companyId || !projectId || !user) throw new Error('Not authenticated')
    const lineRef = doc(collection(db, 'companies', companyId, 'projects', projectId, 'budgetLines'))

    // A budget line is monetary data, so the project currency ratchet is engaged
    // in the SAME transaction as the line — the two succeed or fail together and
    // the project can never end up holding amounts with a still-changeable
    // currency. (A transaction rather than addDoc/writeBatch because the lock
    // write depends on reading the project's current lock state.)
    await runTransaction(db, async (tx) => {
      const commitLock = await stageProjectCurrencyLock(tx, companyId, projectId)

      tx.set(lineRef, {
        costCodeId,
        costCodeName,
        budgeted:  Number(budgeted) || 0,
        committed: 0,
        actual:    0,
        invoiced:  0,
        notes:     notes?.trim() || '',
        createdAt: serverTimestamp(),
        createdBy: user.uid,
      })
      commitLock()
    })
  }, [companyId, projectId, user])

  // Correct an existing budget line (ADR-39).
  //
  // Writes exactly `budgeted` and `notes` plus the audit stamps, and nothing
  // else. The field list is literal, not spread from the caller, so
  // `costCodeId`, `costCodeName` and the vestigial `committed`/`actual`/
  // `invoiced` zeros cannot be smuggled through — and Firestore rules freeze
  // all five independently via an update key allow-list.
  //
  // NO COST-CODE RE-POINTING. Moving an approved budget to a different cost
  // code would relocate it under existing commitments and actuals with no
  // record that it moved. Wrong cost code → add a line on the right code.
  //
  // NO `costCodeName` RE-SNAPSHOT, deliberately diverging from the ADR-36 PO
  // editor: a PO line re-snapshots because its cost code can change in the same
  // edit, whereas here it cannot, so re-snapshotting would rewrite recorded
  // history during an edit made only to a number. The Budget page resolves the
  // CURRENT name at read time instead (lib/costCodes.js → resolveCostCodeName).
  //
  // NO TRANSACTION AND NO CURRENCY RATCHET STAGING: the project locked when
  // this line was created (createBudgetLine stages the ratchet), so there is no
  // state for a second lock write to reach — the ADR-36 reasoning exactly.
  //
  // `updatedAt`/`updatedBy` ARE written, unlike the ADR-36/38 draft editors
  // which skipped stamps because their models carried none. A budget figure
  // has no other trace anywhere in the app — there is no field-level history
  // (docs/SECURITY.md → Deferred Control 7) — so the stamps are the only record
  // that a correction happened. Firestore rules verify them against the caller
  // and the server clock.
  //
  // Concurrent editors are last-write-wins, as everywhere else in the app.
  const updateBudgetLine = useCallback(async (line, { budgeted, notes }) => {
    if (!companyId || !projectId || !user) throw new Error('Not authenticated')
    if (!line?.id) throw new Error('Unknown budget line')

    const fields = buildBudgetLineFields({ budgeted, notes })
    const validationError = validateBudgetLine(fields)
    if (validationError) throw new Error(validationError)

    const ref = doc(db, 'companies', companyId, 'projects', projectId, 'budgetLines', line.id)
    await updateDoc(ref, {
      budgeted:  fields.budgeted,
      notes:     fields.notes,
      updatedAt: serverTimestamp(),
      updatedBy: user.uid,
    })
  }, [companyId, projectId, user])

  return { budgetLines, budgetLinesLoading, budgetLinesError, createBudgetLine, updateBudgetLine }
}
