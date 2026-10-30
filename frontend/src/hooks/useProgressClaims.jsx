import { useEffect, useState, useCallback, useMemo } from 'react'
import {
  collection, doc, onSnapshot, query, orderBy,
  runTransaction, serverTimestamp,
} from 'firebase/firestore'
import { db } from '../lib/firebase'
import { useAuth } from './useAuth'
import { useCompany } from './useCompany'
import { useProject } from './useProject'
import { stageProjectCurrencyLock } from './projectCurrencyLock'
import { resolveProjectCurrency } from '../lib/currency'
import {
  CLAIM_STATUS, CLAIMABLE_PO_STATUSES, canTransition, claimTotals,
  formatClaimNumber, hasOpenClaim, validateClaimDraft, claimVariationLineCount,
} from '../lib/progressClaims'
import { runUpdateClaimDraft, runTransitionClaim, variationSourceError } from '../lib/progressClaimActions'
import { isVariationOriginLine } from '../lib/sourceLine'

export function useProgressClaims(projectId) {
  const { user }    = useAuth()
  const { company } = useCompany()
  const { project } = useProject(projectId)
  // Live subscription state, tagged with the target (`key`) it belongs to —
  // the keyed-snapshot pattern used by useProjectActivities / useDrawings. The
  // effect is subscription-only: state is written ONLY from the async
  // onSnapshot callbacks, never synchronously in the effect body, so
  // progressClaims/loading/error are DERIVED at render time below
  // (react-hooks/set-state-in-effect).
  //
  // `error` is true when the live read failed (connection loss or a rules
  // rejection). Consumers deriving financial figures MUST treat a failed read
  // as UNAVAILABLE — never as a genuine zero. It is exposed only once the
  // CURRENT target has settled, so a project switch never flashes a stale
  // unavailable banner under the new project.
  const [snap, setSnap] = useState({ key: null, progressClaims: [], error: false })

  const companyId = company?.id ?? null

  // The currency this project reports in — project.currency, falling back to
  // the company base currency and finally AUD for records predating the
  // Company Country & Currency foundation.
  const projectCurrency = resolveProjectCurrency(project, company)

  useEffect(() => {
    if (!companyId || !projectId) return undefined

    const key = `${companyId}/${projectId}`
    const ref = collection(db, 'companies', companyId, 'projects', projectId, 'progressClaims')
    const q   = query(ref, orderBy('createdAt', 'desc'))

    const unsubscribe = onSnapshot(
      q,
      (querySnap) => setSnap({
        key,
        progressClaims: querySnap.docs.map(d => ({ id: d.id, ...d.data() })),
        error: false,
      }),
      // A failed read must NOT look like an empty register — "none" and "we
      // could not load them" are opposite facts, and confusing them on a
      // financial register fabricates a zero.
      () => setSnap({ key, progressClaims: [], error: true }),
    )
    return unsubscribe
  }, [companyId, projectId])

  // Derived, at render time: no synchronous setState in the effect. With no
  // target we are idle (no data, not loading); with a target we are loading
  // until the subscription reports for THAT target (`settled`), which also
  // hides the previous project's rows immediately.
  const targetKey = companyId && projectId ? `${companyId}/${projectId}` : null
  const settled = targetKey !== null && snap.key === targetKey
  // Memoised so the write callbacks below (which validate against the live
  // list) keep stable dependencies across renders.
  const progressClaims = useMemo(
    () => (settled ? snap.progressClaims : []),
    [settled, snap.progressClaims],
  )
  const progressClaimsLoading = targetKey !== null && !settled
  const progressClaimsError = settled ? snap.error : false

  // Creates a draft claim against one sent PO. The company-wide counter is read
  // and incremented in the same transaction as the claim write, matching POs.
  // Since ADR-58 (M2-B2) the rules get() the PO at create — it must exist in
  // this project and be `sent`, and the claim's number, supplier snapshot and
  // line count must be the PO's — and require the creator / audit stamps at
  // server time, the exact key set and the whole-cent claimed header. The
  // one-open-claim check below stays CLIENT-ONLY (rules cannot see sibling
  // claims — SECURITY.md Deferred Control 36).
  //
  // M3-B2 (ADR-63): a claim may carry VARIATION-ORIGIN lines after the PO
  // lines — one per positive new-scope line of an approved, applied,
  // scope-committed supplier variation on this PO. The header
  // `variationLineCount` records how many (rules pin the line count to the
  // PO's lines + this number). Every referenced variation AND the PO are
  // re-read INSIDE the transaction and the sources re-validated on the server
  // copies (approved · supplier · same PO · scope-committed · line exists · new
  // scope · positive · cost code matches); a stale or missing source refuses
  // the create with nothing written. Line CONTENTS stay client-only (DC40).
  // The reserved header `variationId` stays null — several variations may
  // share one claim, so the identity lives on the lines.
  const createProgressClaim = useCallback(async ({ po, periodEnding, claimRef, notes, retention, lineItems }) => {
    if (!companyId || !projectId || !user) throw new Error('Not authenticated')
    if (!CLAIMABLE_PO_STATUSES.includes(po.status)) throw new Error('Claims can only be raised against sent purchase orders')
    if (hasOpenClaim(progressClaims, po.id)) throw new Error('This purchase order already has an open claim')
    // The same draft validation the editor and the draft edit apply — the
    // hook is the domain boundary, the editor's disabled button is not.
    const draftError = validateClaimDraft({ lineItems, retention, poId: po.id })
    if (draftError) throw new Error(draftError)
    const variationLineCount = claimVariationLineCount(lineItems)
    const variationIds = [...new Set(lineItems.filter(isVariationOriginLine).map(li => li.variationId))]

    const counterRef  = doc(db, 'companies', companyId, 'counters', 'progressClaims')
    const claimDocRef = doc(collection(db, 'companies', companyId, 'projects', projectId, 'progressClaims'))
    const poRef       = doc(db, 'companies', companyId, 'projects', projectId, 'purchaseOrders', po.id)
    const variationRefs = variationIds.map(id => doc(db, 'companies', companyId, 'projects', projectId, 'variations', id))

    await runTransaction(db, async (tx) => {
      const counterSnap = await tx.get(counterRef)
      const next = counterSnap.exists() ? counterSnap.data().next : 1
      // The currency ratchet is staged during the transaction's READ phase and
      // committed below, so this claim and the project lock succeed or fail
      // together — the project can never hold amounts with a still-changeable
      // currency. Firestore requires all transaction reads before any writes.
      const commitLock = await stageProjectCurrencyLock(tx, companyId, projectId)
      // Source re-validation on the SERVER copies (ADR-63) — fail closed.
      const poSnap = await tx.get(poRef)
      const livePo = poSnap.exists() ? { id: poSnap.id, ...poSnap.data() } : null
      if (!livePo || !CLAIMABLE_PO_STATUSES.includes(livePo.status)) {
        throw new Error(`${po.poNumber || 'The purchase order'} is no longer a sent purchase order on the server, so the claim was not created.`)
      }
      const liveVariations = []
      for (const ref of variationRefs) {
        const snap = await tx.get(ref)
        liveVariations.push(snap.exists() ? { id: snap.id, ...snap.data() } : null)
      }
      const sourceError = variationSourceError(lineItems, { po: livePo, variations: liveVariations, variationIds })
      if (sourceError) throw new Error(sourceError)

      tx.set(counterRef, { next: next + 1 }, { merge: true })

      const totals = claimTotals(lineItems.map(li => li.claimedThisPeriod), retention)
      tx.set(claimDocRef, {
        claimNumber:  formatClaimNumber(next),
        status:       CLAIM_STATUS.DRAFT,
        poId:         po.id,
        poNumber:     po.poNumber,
        supplierName: po.supplierName,
        supplierId:   po.supplierId ?? null,
        claimRef:     claimRef?.trim() || '',
        periodEnding: periodEnding || '',
        variationId:  null,
        variationLineCount,
        lineItems,
        retention:        totals.retention,
        claimedSubtotal:  totals.subtotal,
        claimedGst:       totals.gst,
        claimedTotal:     totals.total,
        approvedSubtotal: null,
        approvedGst:      null,
        approvedTotal:    null,
        notes:            notes?.trim() || '',
        assessmentNotes:  '',
        // Audit snapshot of the currency this document was raised in (the frozen
        // supplierName/costCodeName idiom). The PROJECT currency remains the
        // display authority — this field is never read for rendering, so a
        // project can never show mixed currencies. Historical documents keep
        // their stored 'AUD' and are never rewritten.
        currency:         projectCurrency,
        revision:         1,
        // Lifecycle stamps — born null. Each transition writes its own
        // (at, by) pair; Firestore rules require the actor to be the caller
        // and the time to be the server's (ADR-58). `invoicedAt` is reserved
        // (no application path writes it).
        submittedAt:      null,
        submittedBy:      null,
        approvedAt:       null,
        approvedBy:       null,
        rejectedAt:       null,
        rejectedBy:       null,
        invoicedAt:       null,
        externalRefs:     {},
        createdAt:        serverTimestamp(),
        createdBy:        user.uid,
        // Audit stamps — required by rules on EVERY write since ADR-58.
        updatedAt:        serverTimestamp(),
        updatedBy:        user.uid,
      })
      commitLock()
    })
  }, [companyId, projectId, user, progressClaims, projectCurrency])

  // Draft-only edits (ADR-37) — claimed amounts freeze once a claim is submitted.
  //
  // The caller supplies NO line items. `claimedToDate` is the ordered set of
  // authored cumulative figures, one per STORED line, and the stored claim
  // document is the sole authority for line identity: every line is rebuilt over
  // the SERVER copy's `lineItems` inside the guarded transaction
  // (lib/progressClaimActions.js → runUpdateClaimDraft), so poLineIndex,
  // costCodeId, costCodeName, description, poLineTotal and previouslyApproved
  // cannot be rewritten by any caller. `previouslyApproved` is deliberately NOT
  // re-derived — the one-open-claim rule means no later approved claim can
  // legitimately appear while this draft is open. `claimedThisPeriod` is always
  // re-derived and `approvedThisPeriod` forced null.
  //
  // Since ADR-58 (M2-B2) the edit is a REVISION-GUARDED transaction: the server
  // copy must still be a draft at the revision the user reviewed (STALE
  // otherwise — the editor keeps the user's entries and shows the reason), and
  // the write carries `revision + 1` and the audit stamps. The rules admit
  // exactly these keys on a draft and require the +1, so the draft-only edit
  // and the freeze after submit are RULES-ENFORCED; the status check here is
  // the UX mirror. Immutable fields are never written — updateDoc is partial.
  // No currency ratchet is staged (the project locked when the claim was
  // created).
  const updateProgressClaim = useCallback(async (claim, data) => {
    if (!companyId || !projectId || !user) throw new Error('Not authenticated')
    if (claim.status !== CLAIM_STATUS.DRAFT) throw new Error('Only draft claims can be edited')
    const claimRef = doc(db, 'companies', companyId, 'projects', projectId, 'progressClaims', claim.id)
    await runUpdateClaimDraft({
      db, claimRef, seen: claim, data, uid: user.uid, runTransaction, serverTimestamp,
    })
  }, [companyId, projectId, user])

  // Submit / approve / reject through ONE guarded transaction (ADR-58,
  // lib/progressClaimActions.js): the server copy must still be in the status
  // AND at the revision the user acted on, the move must be legal, and the
  // write is status + the transition's (at, by) stamps + the audit stamps +
  // revision — plus, for approval, the certified lines, the approved header
  // (claimTotals over the certified amounts and the STORED retention) and the
  // assessment notes — exactly what the rules' transition branches admit.
  // `under_review` and `invoiced` are reserved targets with no application
  // path; the transaction refuses them and so do the rules. Approved amounts
  // are frozen forever: an approved claim matches no update branch.
  const transitionStatus = useCallback(async (claim, nextStatus, { approvedAmounts, assessmentNotes } = {}) => {
    if (!companyId || !projectId || !user) throw new Error('Not authenticated')
    if (!canTransition(claim.status, nextStatus)) {
      throw new Error(`Cannot move a ${claim.status} claim to ${nextStatus}`)
    }
    const claimRef = doc(db, 'companies', companyId, 'projects', projectId, 'progressClaims', claim.id)
    await runTransitionClaim({
      db, claimRef, seen: claim, nextStatus, extras: { approvedAmounts, assessmentNotes },
      uid: user.uid, runTransaction, serverTimestamp,
    })
  }, [companyId, projectId, user])

  return { progressClaims, progressClaimsLoading, progressClaimsError, createProgressClaim, updateProgressClaim, transitionStatus }
}
