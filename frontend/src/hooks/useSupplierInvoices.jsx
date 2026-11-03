import { useEffect, useState, useCallback, useMemo } from 'react'
import {
  collection, doc, onSnapshot, query, orderBy,
  runTransaction, updateDoc, serverTimestamp,
} from 'firebase/firestore'
import { db } from '../lib/firebase'
import { useAuth } from './useAuth'
import { useCompany } from './useCompany'
import { useProject } from './useProject'
import { stageProjectCurrencyLock } from './projectCurrencyLock'
import { resolveProjectCurrency } from '../lib/currency'
import {
  SI_STATUS, SI_SOURCE,
  canTransition, invoiceTotals, formatSupplierInvoiceNumber, claimHasActiveInvoice,
  claimReconciliationError, retentionFloorError,
  isEditableInvoice, isClaimSourced, buildInvoiceLine, invoiceLineInputCountError,
  validateInvoiceDraft, claimSourcedDriftError, invoiceVariationLineCount,
  allocateClaimSourcedLineGst, rebuildClaimSourcedLines,
} from '../lib/supplierInvoices'
import { sourceLineIdentityError } from '../lib/sourceLine'
import { isClaimInvoiceable } from '../lib/progressClaims'
import {
  runCreateSupplierInvoice, runCancelSupplierInvoice, SupplierInvoiceWriteError, SI_WRITE_ERROR,
} from '../lib/supplierInvoiceActions'

export function useSupplierInvoices(projectId) {
  const { user }    = useAuth()
  const { company } = useCompany()
  const { project } = useProject(projectId)
  // Live subscription state, tagged with the target (`key`) it belongs to —
  // the keyed-snapshot pattern used by useProjectActivities / useDrawings. The
  // effect is subscription-only: state is written ONLY from the async
  // onSnapshot callbacks, never synchronously in the effect body, so
  // supplierInvoices/loading/error are DERIVED at render time below
  // (react-hooks/set-state-in-effect).
  //
  // `error` is true when the live read failed (connection loss or a rules
  // rejection). Consumers deriving financial figures MUST treat a failed read
  // as UNAVAILABLE — never as a genuine zero. It is exposed only once the
  // CURRENT target has settled, so a project switch never flashes a stale
  // unavailable banner under the new project.
  const [snap, setSnap] = useState({ key: null, supplierInvoices: [], error: false })

  const companyId = company?.id ?? null

  // The currency this project reports in — project.currency, falling back to
  // the company base currency and finally AUD for records predating the
  // Company Country & Currency foundation.
  const projectCurrency = resolveProjectCurrency(project, company)

  useEffect(() => {
    if (!companyId || !projectId) return undefined

    const key = `${companyId}/${projectId}`
    const ref = collection(db, 'companies', companyId, 'projects', projectId, 'supplierInvoices')
    const q   = query(ref, orderBy('createdAt', 'desc'))

    const unsubscribe = onSnapshot(
      q,
      (querySnap) => setSnap({
        key,
        supplierInvoices: querySnap.docs.map(d => ({ id: d.id, ...d.data() })),
        error: false,
      }),
      // A failed read must NOT look like an empty register — "none" and "we
      // could not load them" are opposite facts, and confusing them on a
      // financial register fabricates a zero.
      () => setSnap({ key, supplierInvoices: [], error: true }),
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
  const supplierInvoices = useMemo(
    () => (settled ? snap.supplierInvoices : []),
    [settled, snap.supplierInvoices],
  )
  const supplierInvoicesLoading = targetKey !== null && !settled
  const supplierInvoicesError = settled ? snap.error : false

  // Creates a draft supplier invoice through ONE guarded transaction
  // (lib/supplierInvoiceActions.js → runCreateSupplierInvoice): the
  // company-wide counter is read and incremented in the same transaction as
  // the invoice write, matching POs and claims. The caller supplies
  // supplier/PO/claim snapshots and built line items (ex-GST amount + taxCode
  // + gstAmount per line); totals are derived in the action.
  //
  // SHIELD 2A (ADR-68) — a CLAIM-SOURCED invoice is PAIRED with its claim: the
  // transaction reads the SERVER copy of the approved claim, refuses unless it
  // is still approved, at the revision the editor reviewed, new-format and
  // UNLINKED (ALREADY_INVOICED names the linked invoice; a legacy key-absent
  // claim is LEGACY_UNRECONCILED), names this invoice's PO, supplier and
  // claim number, and still certifies the figures the editor reconciled
  // against — then writes the invoice AND the claim's `supplierInvoiceId`
  // link together. Firestore Rules pair the two halves through getAfter(), so
  // the client-side `claimHasActiveInvoice` check below is a UX fast-path
  // only: the claim document is the authoritative concurrency boundary, and
  // the client's subscribed register is not. The caller passes the reviewed
  // `claim`; the explicit claim fields remain for the editor's preview path.
  const createSupplierInvoice = useCallback(async ({
    source, supplierId, supplierName, poId, poNumber,
    claim = null,
    progressClaimId, claimNumber, claimApprovedGst, claimApprovedTotal,
    supplierInvoiceNumber,
    invoiceDate, receivedDate, dueDate, paymentTerms,
    lineItems, retention, notes,
  }) => {
    if (!companyId || !projectId || !user) throw new Error('Not authenticated')
    // One approved claim may carry only one non-cancelled supplier invoice.
    if (progressClaimId && claimHasActiveInvoice(supplierInvoices, progressClaimId)) {
      throw new Error('This progress claim already has an active supplier invoice')
    }
    if (source === SI_SOURCE.PROGRESS_CLAIM) {
      if (!claim?.id || claim.id !== progressClaimId) {
        throw new Error('Select the approved progress claim this invoice is raised from.')
      }
      if (!isClaimInvoiceable(claim)) {
        throw new SupplierInvoiceWriteError(SI_WRITE_ERROR.LEGACY_UNRECONCILED)
      }
    }

    // ADR-40 — THE RETENTION FLOOR AT CREATE. `invoiceTotals` clamps only the
    // UPPER bound, so a negative retention would flow into the stored document
    // and make the payable exceed the gross invoice value. ADR-38 D6 put this
    // check on the EDIT path only; on create the sole guard was the editor
    // input's `min="0"` attribute, which is browser constraint validation and
    // not a control. Checked here at the DOMAIN boundary, before any total is
    // derived, and mirrored by Firestore Rules (`retention >= 0`, whole cents).
    // The shared helper is the same one validateInvoiceDraft calls, so the two
    // paths cannot drift.
    const retentionError = retentionFloorError(retention)
    if (retentionError) throw new Error(retentionError)

    // ADR-63: every stored line carries exactly one well-formed source
    // identity (a PO line, or a variation line copied from the claim) and no
    // source line twice; a direct PO invoice carries no variation line at all.
    const identityError = sourceLineIdentityError(lineItems, { poId })
    if (identityError) throw new Error(identityError)
    const variationLineCount = invoiceVariationLineCount(lineItems)
    if (source !== SI_SOURCE.PROGRESS_CLAIM && variationLineCount > 0) {
      throw new Error('A direct purchase-order invoice cannot carry variation lines — invoice new-scope work from the approved progress claim.')
    }

    // A claim-sourced invoice carries the certified claim GST APPORTIONED across
    // its taxable lines (lib/supplierInvoices.js → allocateClaimSourcedLineGst,
    // GST boundary hotfix): the editor builds its lines the same way, so this
    // re-application is idempotent and is what the hook writes regardless of
    // what a caller handed in. The apportionment never moves an amount, a tax
    // code or an identity, and refuses (lines unchanged) rather than fabricate
    // a match — the reconciliation guard below still decides.
    const storedLines = source === SI_SOURCE.PROGRESS_CLAIM
      ? allocateClaimSourcedLineGst(lineItems, { certifiedGst: claimApprovedGst, retention })
      : lineItems
    const totals = invoiceTotals(storedLines, retention)
    // A claim-sourced invoice must pay exactly the approved claim's certified
    // GST and total — block creation if it does not reconcile.
    if (source === SI_SOURCE.PROGRESS_CLAIM) {
      const reconcileError = claimReconciliationError(totals, { approvedGst: claimApprovedGst, approvedTotal: claimApprovedTotal })
      if (reconcileError) throw new Error(reconcileError)
    }

    const counterRef  = doc(db, 'companies', companyId, 'counters', 'supplierInvoices')
    const invoiceRef  = doc(collection(db, 'companies', companyId, 'projects', projectId, 'supplierInvoices'))
    const claimRef    = source === SI_SOURCE.PROGRESS_CLAIM
      ? doc(db, 'companies', companyId, 'projects', projectId, 'progressClaims', progressClaimId)
      : null

    // The document shape (lib/supplierInvoiceActions.js →
    // buildSupplierInvoiceDocument) is the ADR-40 one: born draft, every
    // lifecycle stamp null, the audit stamps required on every write, paidAt
    // deprecated in place (ADR-24), the currency an audit snapshot. The
    // currency ratchet is staged during the transaction's READ phase and
    // committed with the writes, so the invoice and the project lock succeed
    // or fail together.
    const outcome = await runCreateSupplierInvoice({
      db,
      refs: { counterRef, invoiceRef, claimRef },
      document: {
        source, supplierId, supplierName, poId, poNumber,
        progressClaimId: progressClaimId ?? null, claimNumber: claimNumber ?? null, variationLineCount,
        supplierInvoiceNumber, invoiceDate, receivedDate, dueDate, paymentTerms,
        lineItems: storedLines, retention: totals.retention, currency: projectCurrency, notes,
      },
      seenClaim: source === SI_SOURCE.PROGRESS_CLAIM ? claim : null,
      uid: user.uid,
      runTransaction, serverTimestamp,
      stageLock: (tx) => stageProjectCurrencyLock(tx, companyId, projectId),
      formatNumber: formatSupplierInvoiceNumber,
    })
    return outcome.invoiceId
  }, [companyId, projectId, user, supplierInvoices, projectCurrency])

  // ── Draft-only edits (ADR-38) ──────────────────────────────────────────────
  //
  // Corrects a DRAFT supplier invoice in place. `approved` is the authoring
  // freeze point (`posted`, later, is the financial counting point), so this
  // refuses anything that is not still a draft.
  //
  // ⚠️ THAT GUARD IS NOW RULES-ENFORCED TOO (ADR-40). Firestore rules on this
  // collection no longer check only role and tenancy: draft-only editing, the
  // approved authoring freeze, posted and cancelled immutability, the immutable
  // identity set, and the scalar header arithmetic are all enforced at the trust
  // boundary. A direct-SDK caller can NOT rewrite an approved or posted invoice.
  //
  // What is still CLIENT-SIDE ONLY, and must never be described otherwise: the
  // PER-LINE contents below — poLineIndex / costCodeId / costCodeName /
  // description identity, per-line amount sign, tax-code validity, and the
  // gstAmount re-derivation. Rules can neither iterate nor index an array, so
  // they enforce only the line COUNT and the scalar header totals
  // (docs/SECURITY.md → Deferred Control 29).
  //
  // THE CALLER SUPPLIES NO LINE ITEMS. Every line is rebuilt over the STORED
  // document, which makes it the sole authority for line identity: poLineIndex,
  // costCodeId, costCodeName and description are structurally unwritable, and
  // `gstAmount` is always re-derived from the amount and tax code rather than
  // believed. The stored line SET is likewise fixed — there is no add, remove,
  // reorder or reseed channel, because poLineIndex is the identity
  // postedInvoicedByPoLine keys off to mature Committed.
  //
  // Nothing outside the authored set is written: invoiceNumber, status, docType,
  // source, supplier / PO / claim identity, paymentTerms, currency, revision,
  // every lifecycle stamp, paidAt, adjustsInvoiceId, attachments, externalRefs
  // and createdAt/createdBy are all absent from every payload below and survive
  // the partial updateDoc untouched.
  //
  // No transaction, no counter and no currency ratchet: no number is allocated,
  // and the project currency lock was already committed when the invoice was
  // created — re-staging it on an already-locked project would be REJECTED for a
  // `qs` user by the deliberately narrow rule on that field.
  const updateSupplierInvoice = useCallback(async (invoice, {
    supplierInvoiceNumber, invoiceDate, receivedDate, dueDate, notes,
    amounts, taxCodes, retention,
  } = {}) => {
    if (!companyId || !projectId || !user) throw new Error('Not authenticated')
    if (!isEditableInvoice(invoice)) throw new Error('Only draft supplier invoices can be edited')

    const storedLines = Array.isArray(invoice.lineItems) ? invoice.lineItems : []
    const ref = doc(db, 'companies', companyId, 'projects', projectId, 'supplierInvoices', invoice.id)

    // The authored header — the only fields BOTH sources may change — plus the
    // ADR-40 audit stamps every write to this collection must carry.
    //
    // ⚠️ THIS OBJECT IS THE CLAIM-SOURCED RULES CONTRACT. The Firestore Rules
    // branch for a `progress_claim` draft edit is
    // `changedKeys().hasOnly(['supplierInvoiceNumber', 'invoiceDate',
    // 'receivedDate', 'dueDate', 'notes', 'updatedAt', 'updatedBy'])` — exactly
    // these seven keys. Adding a key here without adding it there will be
    // REJECTED by rules in production.
    const header = {
      supplierInvoiceNumber: supplierInvoiceNumber?.trim() || '',
      invoiceDate:  invoiceDate  || '',
      receivedDate: receivedDate || '',
      dueDate:      dueDate      || '',
      notes:        notes?.trim() || '',
      updatedAt:    serverTimestamp(),
      updatedBy:    user.uid,
    }

    // ── progress_claim: HEADER ONLY ──────────────────────────────────────────
    // The line amounts, tax codes and retention ARE the approved claim's
    // certified values, and the invoice must keep paying exactly the claim's
    // certified GST and total. That invariant is made structurally unbreakable
    // rather than merely validated: `amounts`, `taxCodes` and `retention` are
    // IGNORED here, and the payload carries no financial field at all — so no
    // caller, editor or otherwise, has a channel to move certified money.
    //
    // The rebuild below writes nothing. It exists only to prove the stored
    // document still reconciles with itself before a header correction is
    // allowed; a draft whose stored header totals disagree with the certified
    // GST its own amounts, tax codes and retention imply (legacy or forged) is
    // REFUSED with a clear message rather than being mutated into agreement.
    // The rebuild apportions the certified GST exactly as CREATE did
    // (lib/supplierInvoices.js → rebuildClaimSourcedLines, GST boundary
    // hotfix). No progress claim is read or modified.
    if (isClaimSourced(invoice)) {
      const lineItems = rebuildClaimSourcedLines(storedLines, invoice.retention)
      const draftError = validateInvoiceDraft({
        lineItems,
        supplierInvoiceNumber,
        invoiceDate,
        retention:     invoice.retention,
        authoredLines: false,
      })
      if (draftError) throw new Error(draftError)
      const driftError = claimSourcedDriftError(invoice, invoiceTotals(lineItems, invoice.retention))
      if (driftError) throw new Error(driftError)
      await updateDoc(ref, header)
      return
    }

    // ── direct_po: header + per-line amount / tax code + retention ───────────
    // Exact positional pairing — one amount and one tax code per STORED line, in
    // stored order. A mismatch would silently pair authored values with the wrong
    // lines, so nothing is written.
    const countError = invoiceLineInputCountError(storedLines, amounts, taxCodes)
    if (countError) throw new Error(countError)

    const lineItems = storedLines.map((li, idx) =>
      buildInvoiceLine(li, { amount: amounts[idx], taxCode: taxCodes[idx] })
    )
    const draftError = validateInvoiceDraft({ lineItems, supplierInvoiceNumber, invoiceDate, retention })
    if (draftError) throw new Error(draftError)

    const totals = invoiceTotals(lineItems, retention)
    await updateDoc(ref, {
      ...header,
      lineItems,
      retention:      totals.retention,
      retentionGst:   totals.retentionGst,
      retentionTotal: totals.retentionTotal,
      subtotal:       totals.subtotal,
      gstTotal:       totals.gstTotal,
      grossTotal:     totals.grossTotal,
      net:            totals.net,
      payableGst:     totals.payableGst,
      payableTotal:   totals.payableTotal,
    })
  }, [companyId, projectId, user])

  // Lifecycle transitions. approve/post/cancel each carry the acting user and
  // stamp the server time. Posting is the financial commit point and is terminal
  // — posted invoices cannot be cancelled or unposted (corrections are Supplier
  // Credit Notes, ADR-31).
  //
  // ⚠️ LEGALITY IS RULES-ENFORCED (ADR-40), unlike POs and progress claims,
  // where it remains client-checked. `canTransition` below is now a UX
  // fast-path that produces a friendly message; Firestore Rules permit exactly
  // draft→approved, draft→cancelled, approved→posted and approved→cancelled,
  // and match no branch at all from `posted` or `cancelled`. The reserved
  // statuses (`received`, `under_review`, `disputed`) and the deprecated `paid`
  // are unauthorable from any path, which closes the ADR-24 hole in which a
  // direct-SDK caller could forge `status: 'paid'` on a real invoice.
  //
  // SHIELD 2A (ADR-68) — CANCELLATION IS A TRANSACTION
  // (lib/supplierInvoiceActions.js → runCancelSupplierInvoice): a claim-sourced
  // invoice whose claim links to it is cancelled AND its claim unlinked in the
  // same commit (the rules refuse one without the other); an invoice its
  // claim does not link — legacy, or a claim that no longer exists — cancels
  // exactly as before, and no link is invented. Posted stays terminal.
  const transitionStatus = useCallback(async (invoice, nextStatus) => {
    if (!companyId || !projectId || !user) throw new Error('Not authenticated')
    if (!canTransition(invoice.status, nextStatus)) {
      throw new Error(`Cannot move a ${invoice.status} supplier invoice to ${nextStatus}`)
    }
    const ref = doc(db, 'companies', companyId, 'projects', projectId, 'supplierInvoices', invoice.id)
    if (nextStatus === SI_STATUS.CANCELLED) {
      const claimRef = isClaimSourced(invoice) && invoice.progressClaimId
        ? doc(db, 'companies', companyId, 'projects', projectId, 'progressClaims', invoice.progressClaimId)
        : null
      await runCancelSupplierInvoice({ db, invoiceRef: ref, claimRef, seen: invoice, uid: user.uid, runTransaction, serverTimestamp })
      return
    }
    const extra =
      nextStatus === SI_STATUS.APPROVED  ? { approvedAt:  serverTimestamp(), approvedBy:  user.uid } :
      nextStatus === SI_STATUS.POSTED    ? { postedAt:    serverTimestamp(), postedBy:    user.uid } :
      {}
    // ⚠️ EACH PAYLOAD IS A RULES CONTRACT (ADR-40). Firestore Rules restrict
    // every transition with `changedKeys().hasOnly([...])` to exactly `status`,
    // its own two stamps, and `updatedAt`/`updatedBy` — so a transition can
    // carry NO content change, and adding a key here without adding it to the
    // matching rules branch will be REJECTED in production.
    await updateDoc(ref, {
      status: nextStatus,
      ...extra,
      updatedAt: serverTimestamp(),
      updatedBy: user.uid,
    })
  }, [companyId, projectId, user])

  return { supplierInvoices, supplierInvoicesLoading, supplierInvoicesError, createSupplierInvoice, updateSupplierInvoice, transitionStatus }
}
