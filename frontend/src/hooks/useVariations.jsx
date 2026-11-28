import { useEffect, useState, useCallback } from 'react'
import {
  collection, doc, onSnapshot, query, orderBy,
  runTransaction, serverTimestamp,
} from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import { db, functions } from '../lib/firebase'
import { useAuth } from './useAuth'
import { useCompany } from './useCompany'
import { VARIATION_STATUS, canTransition, isPoLinkedSupplierVariation } from '../lib/variations'
import {
  runUpdateVariationDraft, runTransitionVariation,
  runCreateVariation, runApproveVariation, runApplyVariationCommitment, VARIATION_CALL_TIMEOUT_MS,
} from '../lib/variationActions'

// The three server operations (ADR-90) through ONE injected caller, so
// lib/variationActions.js imports no Firebase code.
const callVariationFunction = async (name, data) =>
  (await httpsCallable(functions, name, { timeout: VARIATION_CALL_TIMEOUT_MS })(data)).data

export function useVariations(projectId) {
  const { user }    = useAuth()
  const { company } = useCompany()
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

  // A fresh document id for ONE new variation. The editor asks for it once,
  // when it opens, and passes it to createVariation on every attempt — which
  // is what makes a repeated save after an uncertain outcome safe: the server
  // answers "already created" for an id it has already written (ADR-90).
  const newVariationId = useCallback(() => {
    if (!companyId || !projectId) throw new Error('Not authenticated')
    return doc(collection(db, 'companies', companyId, 'projects', projectId, 'variations')).id
  }, [companyId, projectId])

  // Creates a draft variation THROUGH THE TRUSTED BACKEND (ADR-90,
  // `createVariation`). The browser sends what the user authored — the title,
  // the dates, each line's ex-GST amount, tax code and cost code (or the PO
  // line it changes), the counterparty and the ids of the purchase order and
  // originating RFI. The server assigns the number from the type's counter,
  // takes the supplier and every PO-line cost code from the purchase order,
  // the cost-code names from the library and the RFI number and title from the
  // RFI, resolves the currency, derives every GST figure and total under
  // calculation version 2 (ADR-91), engages the project currency lock and
  // writes one audit event — in one transaction. Security Rules refuse a
  // direct create from any client.
  const createVariation = useCallback(async (data) => {
    if (!companyId || !projectId || !user) throw new Error('Not authenticated')
    const variationId = data?.variationId ?? newVariationId()
    const result = await runCreateVariation({
      call: callVariationFunction, projectId, variationId, data, uid: user.uid,
    })
    return result.variationId
  }, [companyId, projectId, user, newVariationId])

  // Draft-only edits (ADR-35) THROUGH THE TRUSTED BACKEND (ADR-90,
  // `updateVariationDraft`). The browser sends the revision of the draft the
  // editor was opened on and what the user authored; the server refuses unless
  // the stored variation is still a draft at THAT revision (STALE otherwise —
  // the editor keeps the user's entries), derives every line, GST figure and
  // the header again, and stores the draft under the current calculation
  // version. Identity, type, counterparty, purchase-order link, status and
  // stamps are never written. `notes` omitted keeps the stored notes; the
  // originating RFI is touched ONLY when `originRfi` is passed (an RFI document
  // to set or change, or null to unlink) — undefined keeps the stored link,
  // which is how a link to a since-cancelled RFI survives unrelated edits.
  // Security Rules refuse a direct content edit from any client.
  const updateVariation = useCallback(async (variation, data) => {
    if (!companyId || !projectId || !user) throw new Error('Not authenticated')
    if (variation.status !== VARIATION_STATUS.DRAFT) throw new Error('Only draft variations can be edited')
    return runUpdateVariationDraft({
      call: callVariationFunction, projectId, seen: variation, data, uid: user.uid,
    })
  }, [companyId, projectId, user])

  // Submit / reject / withdraw through ONE guarded transaction (ADR-59,
  // lib/variationActions.js): the server copy must still be in the status AND
  // at the revision the user acted on, the move must be legal (canTransition),
  // and the write is status + the transition's (at, by) stamps + the audit
  // stamps + revision (+ the submitted date on submit, the notes on reject).
  // Exactly what the rules' transition branches admit. The reserved
  // under_review / disputed / superseded have no application path; approved,
  // rejected and withdrawn are terminal — approved amounts freeze forever.
  //
  // APPROVAL IS PROCESSED BY THE TRUSTED BACKEND (ADR-90, `approveVariation`).
  // The browser sends the revision the approver reviewed, the certified amount
  // per line (unbounded — above/below/zero/negative allowed), the assessment
  // notes and the approver's calendar day. The server refuses unless the
  // variation is still submitted at THAT revision, derives every GST figure
  // and the SIGNED approved header under the variation's own calculation
  // version, and — for a PO-linked supplier variation (ADR-62 / ADR-63) —
  // approves AND applies it to the purchase order's commitment in the same
  // write, only while the order is sent or closed on the server; a missing,
  // draft, pending or cancelled order REFUSES the approval. Returns the
  // outcome (`commitmentApplied`), so the page can say which happened.
  const transitionStatus = useCallback(async (variation, nextStatus, { approvedAmounts, assessmentNotes } = {}) => {
    if (!companyId || !projectId || !user) throw new Error('Not authenticated')
    if (!canTransition(variation.status, nextStatus)) {
      throw new Error(`Cannot move a ${variation.status} variation to ${nextStatus}`)
    }
    if (nextStatus === VARIATION_STATUS.APPROVED) {
      return runApproveVariation({
        call: callVariationFunction, projectId, seen: variation, approvedAmounts, assessmentNotes, uid: user.uid,
      })
    }
    const variationRef = doc(db, 'companies', companyId, 'projects', projectId, 'variations', variation.id)
    return runTransitionVariation({
      db, variationRef, seen: variation, nextStatus, extras: { assessmentNotes },
      uid: user.uid, runTransaction, serverTimestamp,
    })
  }, [companyId, projectId, user])

  // Legacy Apply / Commit new scope (ADR-62 / ADR-63): the one-time
  // application of an approved, PO-linked supplier variation that lacks a
  // commitment stamp pair — processed by the trusted backend (ADR-90,
  // `applyVariationCommitment`). The server copy must still be at the revision
  // the user reviewed, the purchase order must exist and be sent or closed on
  // the server, and the write is the missing pair(s) + revision + audit
  // stamps. A pair that is present is never rewritten.
  const applyVariationCommitment = useCallback(async (variation) => {
    if (!companyId || !projectId || !user) throw new Error('Not authenticated')
    if (!isPoLinkedSupplierVariation(variation)) throw new Error('This variation names no purchase order')
    return runApplyVariationCommitment({
      call: callVariationFunction, projectId, seen: variation, uid: user.uid,
    })
  }, [companyId, projectId, user])

  return {
    variations, variationsLoading, variationsError,
    createVariation, newVariationId, updateVariation, transitionStatus, applyVariationCommitment,
  }
}
