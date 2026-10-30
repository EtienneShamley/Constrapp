import { useEffect, useState, useCallback } from 'react'
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
  VARIATION_TYPE, VARIATION_STATUS, VARIATION_COUNTER_ID,
  canTransition, variationTotals,
  formatClientVariationNumber, formatSupplierVariationNumber,
  normaliseOriginRfi, isEligibleOriginRfi,
  validateVariationDraft, isPoLinkedSupplierVariation,
} from '../lib/variations'
import { runUpdateVariationDraft, runTransitionVariation, runApplyVariationCommitment } from '../lib/variationActions'

export function useVariations(projectId) {
  const { user }    = useAuth()
  const { company } = useCompany()
  const { project } = useProject(projectId)
  // Live subscription state, tagged with the target (`key`) it belongs to —
  // the keyed-snapshot pattern used by useProjectActivities / useDrawings. The
  // effect is subscription-only: state is written ONLY from the async
  // onSnapshot callbacks, never synchronously in the effect body, so
  // variations/loading/error are DERIVED at render time below
  // (react-hooks/set-state-in-effect).
  //
  // `error` is true when the live read failed (connection loss or a rules
  // rejection). Consumers deriving financial figures MUST treat a failed read
  // as UNAVAILABLE — never as a genuine zero. It is exposed only once the
  // CURRENT target has settled, so a project switch never flashes a stale
  // unavailable banner under the new project.
  const [snap, setSnap] = useState({ key: null, variations: [], error: false })

  const companyId = company?.id ?? null

  // The currency this project reports in — project.currency, falling back to
  // the company base currency and finally AUD for records predating the
  // Company Country & Currency foundation.
  const projectCurrency = resolveProjectCurrency(project, company)

  useEffect(() => {
    if (!companyId || !projectId) return undefined

    const key = `${companyId}/${projectId}`
    const ref = collection(db, 'companies', companyId, 'projects', projectId, 'variations')
    const q   = query(ref, orderBy('createdAt', 'desc'))

    const unsubscribe = onSnapshot(
      q,
      (querySnap) => setSnap({
        key,
        variations: querySnap.docs.map(d => ({ id: d.id, ...d.data() })),
        error: false,
      }),
      // A failed read must NOT look like an empty register — "none" and "we
      // could not load them" are opposite facts, and confusing them on a
      // financial register fabricates a zero.
      () => setSnap({ key, variations: [], error: true }),
    )
    return unsubscribe
  }, [companyId, projectId])

  // Derived, at render time: no synchronous setState in the effect. With no
  // target we are idle (no data, not loading); with a target we are loading
  // until the subscription reports for THAT target (`settled`), which also
  // hides the previous project's rows immediately.
  const targetKey = companyId && projectId ? `${companyId}/${projectId}` : null
  const settled = targetKey !== null && snap.key === targetKey
  const variations = settled ? snap.variations : []
  const variationsLoading = targetKey !== null && !settled
  const variationsError = settled ? snap.error : false

  // Creates a draft variation. The type's company-wide counter
  // (variationsClient / variationsSupplier) is read and incremented in the same
  // transaction as the write, matching POs/claims/invoices. The caller supplies
  // the counterparty/PO snapshots and built line items (ex-GST submittedAmount +
  // taxCode + submittedGst per line); submitted totals are derived here. Fields
  // that do not apply to the type are stored as null. `originRfi` is the
  // optional originating RFI document (evidence link, ADR-34) — snapshotted
  // into originRfiId/Number/Title, or the all-null triple when absent.
  const createVariation = useCallback(async ({
    variationType,
    title, description, reason,
    clientId, clientName, clientRef,
    supplierId, supplierName, supplierRef,
    poId, poNumber,
    identifiedDate, submittedDate, responseDueDate, effectiveDate,
    lineItems, notes,
    originRfi = null,
  }) => {
    if (!companyId || !projectId || !user) throw new Error('Not authenticated')
    if (originRfi && !isEligibleOriginRfi(originRfi)) throw new Error('Only open, answered or closed RFIs can originate a variation')
    const draftError = validateVariationDraft({ title, lineItems })
    if (draftError) throw new Error(draftError)
    const isClient = variationType === VARIATION_TYPE.CLIENT

    const counterRef = doc(db, 'companies', companyId, 'counters', VARIATION_COUNTER_ID[variationType])
    const varRef     = doc(collection(db, 'companies', companyId, 'projects', projectId, 'variations'))

    await runTransaction(db, async (tx) => {
      const counterSnap = await tx.get(counterRef)
      const next = counterSnap.exists() ? counterSnap.data().next : 1
      // The currency ratchet is staged during the transaction's READ phase and
      // committed below, so this variation and the project lock succeed or fail
      // together — the project can never hold amounts with a still-changeable
      // currency. Firestore requires all transaction reads before any writes.
      const commitLock = await stageProjectCurrencyLock(tx, companyId, projectId)

      tx.set(counterRef, { next: next + 1 }, { merge: true })

      const submitted = variationTotals(lineItems, 'submitted')
      tx.set(varRef, {
        variationNumber: isClient ? formatClientVariationNumber(next) : formatSupplierVariationNumber(next),
        variationType,
        status: VARIATION_STATUS.DRAFT,

        title:       title?.trim()       || '',
        description: description?.trim() || '',
        reason:      reason || '',

        // Counterparty — only the block for this type is populated; the other is null.
        clientId:   isClient ? (clientId ?? null) : null,
        clientName: isClient ? ((clientName || '').trim()) : null,
        clientRef:  isClient ? (clientRef?.trim() || '') : null,

        supplierId:   isClient ? null : (supplierId ?? null),
        supplierName: isClient ? null : ((supplierName || '').trim()),
        supplierRef:  isClient ? null : (supplierRef?.trim() || ''),

        poId:     isClient ? null : (poId ?? null),
        poNumber: isClient ? null : (poNumber ?? null),

        // Originating RFI — evidence link only (ADR-34). Rules verify the RFI
        // exists in this project, is open/answered/closed, and that the two
        // snapshots match it exactly.
        ...normaliseOriginRfi(originRfi),

        lineItems,

        // Money — ex-GST canonical; header totals derive from lines.
        submittedSubtotal: submitted.subtotal,
        submittedGst:      submitted.gst,
        submittedTotal:    submitted.total,
        approvedSubtotal:  null,
        approvedGst:       null,
        approvedTotal:     null,
        forecastAmount:    null, // reserved — likely settlement value for future forecast

        // Dates (human 'YYYY-MM-DD' strings).
        identifiedDate:  identifiedDate  || '',
        submittedDate:   submittedDate   || '',
        responseDueDate: responseDueDate || '',
        approvedDate:    '',
        effectiveDate:   effectiveDate   || '',

        // Audit snapshot of the currency this document was raised in (the frozen
        // supplierName/costCodeName idiom). The PROJECT currency remains the
        // display authority — this field is never read for rendering, so a
        // project can never show mixed currencies. Historical documents keep
        // their stored 'AUD' and are never rewritten.
        currency: projectCurrency,
        revision: 1,
        notes:           notes?.trim() || '',
        assessmentNotes: '',

        // Audit stamps.
        submittedAt: null, submittedBy: null,
        approvedAt:  null, approvedBy:  null,
        rejectedAt:  null, rejectedBy:  null,
        withdrawnAt: null, withdrawnBy: null,

        // Reserved for future modules (Storage uploads, accounting, revisions).
        attachments:            [],
        externalRefs:           {},
        supersededByVariationId: null,

        createdAt: serverTimestamp(),
        createdBy: user.uid,
        // Audit stamps (ADR-59) — required by rules on every write.
        updatedAt: serverTimestamp(),
        updatedBy: user.uid,
      })
      commitLock()
    })
    return varRef.id
  }, [companyId, projectId, user, projectCurrency])

  // Draft-only edits (ADR-35) — authored content freezes once a variation is
  // submitted. The caller supplies rebuilt line items; the approved side of
  // every line is forced null (a draft never carries certified values) and
  // submitted totals are re-derived. Identity, type, counterparty, PO, status,
  // stamps and the approved totals are never written. `notes` has no editor
  // input — when omitted (undefined) the stored value is preserved. The
  // originating RFI is touched ONLY when `originRfi` is passed (an RFI
  // document to set/change, or null to unlink); undefined preserves the stored
  // triple — which is what keeps a historical link to a since-cancelled RFI
  // intact across unrelated edits (rules never revalidate an unchanged triple).
  //
  // Since ADR-59 (M2-B3) the edit is a REVISION-GUARDED transaction
  // (lib/variationActions.js → runUpdateVariationDraft): the server copy must
  // still be a draft at the revision the user reviewed (STALE otherwise — the
  // editor keeps the user's entries and shows the reason), and the write
  // carries `revision + 1` and the audit stamps. The rules admit exactly these
  // keys on a draft and require the +1, so the draft-only edit and the freeze
  // after submit are RULES-ENFORCED; the status check here is the UX mirror.
  const updateVariation = useCallback(async (variation, data) => {
    if (!companyId || !projectId || !user) throw new Error('Not authenticated')
    if (variation.status !== VARIATION_STATUS.DRAFT) throw new Error('Only draft variations can be edited')
    const variationRef = doc(db, 'companies', companyId, 'projects', projectId, 'variations', variation.id)
    await runUpdateVariationDraft({
      db, variationRef, seen: variation, data, uid: user.uid, runTransaction, serverTimestamp,
    })
  }, [companyId, projectId, user])

  // Submit / approve / reject / withdraw through ONE guarded transaction
  // (ADR-59, lib/variationActions.js): the server copy must still be in the
  // status AND at the revision the user acted on, the move must be legal
  // (canTransition), and the write is status + the transition's (at, by)
  // stamps + the audit stamps + revision — plus, for approval, the certified
  // lines (unbounded — above/below/zero/negative allowed), the SIGNED approved
  // header, the assessment notes (required when any amount differs — client
  // validation) and the approved / effective dates; for submit, the submitted
  // date. Exactly what the rules' transition branches admit. The reserved
  // under_review / disputed / superseded have no application path; approved,
  // rejected and withdrawn are terminal — approved amounts freeze forever.
  //
  // M3-B1 (ADR-62): approving a PO-LINKED SUPPLIER variation also applies it
  // to the PO's commitment in the SAME write when the PO is sent/closed on the
  // server — the transaction reads the PO after the variation and writes the
  // `commitmentAppliedAt/By` pair the rules verify (actor, server time, PO
  // state). A cancelled, draft or missing PO approves the variation as
  // UNAPPLIED exposure instead; nothing is refused. Returns the outcome
  // (`commitmentApplied`), so the page can say which happened.
  const transitionStatus = useCallback(async (variation, nextStatus, { approvedAmounts, assessmentNotes } = {}) => {
    if (!companyId || !projectId || !user) throw new Error('Not authenticated')
    if (!canTransition(variation.status, nextStatus)) {
      throw new Error(`Cannot move a ${variation.status} variation to ${nextStatus}`)
    }
    const variationRef = doc(db, 'companies', companyId, 'projects', projectId, 'variations', variation.id)
    const poRef = nextStatus === VARIATION_STATUS.APPROVED && isPoLinkedSupplierVariation(variation)
      ? doc(db, 'companies', companyId, 'projects', projectId, 'purchaseOrders', variation.poId)
      : null
    return runTransitionVariation({
      db, variationRef, poRef, seen: variation, nextStatus, extras: { approvedAmounts, assessmentNotes },
      uid: user.uid, runTransaction, serverTimestamp,
    })
  }, [companyId, projectId, user])

  // Legacy Apply (M3-B1, ADR-62): the one-time application of an approved,
  // PO-linked supplier variation that carries no commitment stamps. ONE guarded
  // transaction (lib/variationActions.js → runApplyVariationCommitment): the
  // server copy must still be approved, unapplied and at the revision the user
  // reviewed; the PO must exist and be sent/closed on the server; the write is
  // the stamp pair + revision + audit stamps. Rules enforce the stamps, the
  // null precondition (so a repeat is refused by the database), the PO state
  // and the allow-list independently.
  const applyVariationCommitment = useCallback(async (variation) => {
    if (!companyId || !projectId || !user) throw new Error('Not authenticated')
    if (!isPoLinkedSupplierVariation(variation)) throw new Error('This variation names no purchase order')
    const base = ['companies', companyId, 'projects', projectId]
    return runApplyVariationCommitment({
      db,
      variationRef: doc(db, ...base, 'variations', variation.id),
      poRef:        doc(db, ...base, 'purchaseOrders', variation.poId),
      seen: variation, uid: user.uid, runTransaction, serverTimestamp,
    })
  }, [companyId, projectId, user])

  return {
    variations, variationsLoading, variationsError,
    createVariation, updateVariation, transitionStatus, applyVariationCommitment,
  }
}
