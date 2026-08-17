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
  RR_STATUS, RR_DOC_TYPE, RETENTION_RELEASE_COUNTER_ID,
  formatRetentionReleaseNumber, releaseTotals, releasedExGstForInvoice,
  validateReleaseDraft, postBlockedReason,
} from '../lib/retention'

// ── Retention Releases ───────────────────────────────────────────────────────
//
// A Retention Release is the authored commercial event that makes retention
// ALREADY WITHHELD on a posted Supplier Invoice payable. It is an INTERNAL
// COMMERCIAL AUTHORISATION — not a supplier invoice, not a tax invoice, not a
// credit note, and not a payment. It moves no cash: only a posted Supplier
// Payment does that.
//
// ⚠️ THIS HOOK WRITES ONLY retentionRelease DOCUMENTS (plus the company counter
// and the project currency ratchet, inside the create transaction). It NEVER
// touches a supplier invoice: `retention`, `retentionGst`, and `retentionTotal`
// are immutable for the life of that document, no release reference is stamped
// onto it, and no rollup is written anywhere. Released amounts are derived at
// read time (lib/retention.js → releasedByInvoiceId), which is exactly why
// voiding a release restores every payable balance at the next render with no
// reversal document.
//
// ⚠️ THE CUMULATIVE CAP IS CLIENT-ENFORCED AND IS NOT THE SECURITY BOUNDARY.
// Firestore rules verify the target invoice (exists + posted), the PER-DOCUMENT
// cap (previouslyReleasedAmount + amount ≤ invoice.retention), and the exact GST
// formula — but they cannot sum sibling releases, so they cannot prove
// `previouslyReleasedAmount` is truthful. Two clients can compute the same
// remaining retention concurrently and both writes succeed. The checks below
// stop the NORMAL UI from ever knowingly creating an over-release; they are a
// correctness guard, never a guarantee. See docs/SECURITY.md → Deferred
// Control 24.
export function useRetentionReleases(projectId) {
  const { user }    = useAuth()
  const { company } = useCompany()
  const { project } = useProject(projectId)

  const companyId = company?.id ?? null

  // The currency this project reports in — project.currency, falling back to
  // the company base currency and finally AUD.
  const projectCurrency = resolveProjectCurrency(project, company)

  // Live subscription state, tagged with the target (`key`) it belongs to — the
  // derived-loading pattern used by useSupplierPayments/useCashFlowLines.
  const [snap, setSnap] = useState({ key: null, releases: [], error: false })

  useEffect(() => {
    if (!companyId || !projectId) return undefined

    const key = `${companyId}/${projectId}`
    const ref = collection(db, 'companies', companyId, 'projects', projectId, 'retentionReleases')
    const q   = query(ref, orderBy('createdAt', 'desc'))

    const unsubscribe = onSnapshot(
      q,
      (querySnap) => setSnap({
        key,
        releases: querySnap.docs.map(d => ({ id: d.id, ...d.data() })),
        error: false,
      }),
      // Read error (most often a rules rejection for a non-financial role) —
      // degrade gracefully. ⚠️ Consumers MUST treat this as UNAVAILABLE, never
      // as "nothing released": an empty list would silently understate every
      // payable balance that includes released retention.
      () => setSnap({ key, releases: [], error: true }),
    )
    return unsubscribe
  }, [companyId, projectId])

  const targetKey = companyId && projectId ? `${companyId}/${projectId}` : null
  const settled = targetKey !== null && snap.key === targetKey
  // Memoised because the write callbacks below VALIDATE against this list (the
  // cumulative cap and the previouslyReleasedAmount snapshot). A fresh `[]` on
  // every render would change their identity on every render.
  const retentionReleases = useMemo(() => (settled ? snap.releases : []), [settled, snap.releases])
  const retentionReleasesLoading = targetKey !== null && !settled
  const retentionReleasesError = settled ? snap.error : false

  // Creates a DRAFT release. The company-wide counter is read and incremented in
  // the same transaction as the release write, matching POs/claims/invoices, and
  // the project currency ratchet is staged in the same transaction (ADR-21) —
  // a release is monetary data, so the first one locks the project currency and
  // a failed create writes neither release, number, nor lock.
  //
  // `previouslyReleasedAmount` is a DERIVED SNAPSHOT computed here from the
  // currently-loaded POSTED releases. It is never authored by the user, and it
  // is what makes the partial-release GST telescope exactly to the invoice's
  // stored retentionGst (see lib/retention.js).
  const createRetentionRelease = useCallback(async ({
    invoice, releaseDate, amount, reason, notes,
  }) => {
    if (!companyId || !projectId || !user) throw new Error('Not authenticated')
    // Never author a release while the release set is unknown — the snapshot and
    // the cumulative cap would both be computed against incomplete state.
    if (retentionReleasesError) {
      throw new Error('Retention releases could not be loaded, so the amount already released is unknown. Reload before releasing retention.')
    }

    const validationError = validateReleaseDraft({
      supplierInvoiceId: invoice?.id,
      amount, releaseDate, reason,
      invoices: [invoice],
      releases: retentionReleases,
    })
    if (validationError) throw new Error(validationError)

    const previouslyReleased = releasedExGstForInvoice(retentionReleases, invoice.id)
    const totals = releaseTotals(previouslyReleased, amount)

    const counterRef = doc(db, 'companies', companyId, 'counters', RETENTION_RELEASE_COUNTER_ID)
    const releaseRef = doc(collection(db, 'companies', companyId, 'projects', projectId, 'retentionReleases'))

    await runTransaction(db, async (tx) => {
      // Read phase first (Firestore requires all reads before any writes).
      const counterSnap = await tx.get(counterRef)
      const next = counterSnap.exists() ? counterSnap.data().next : 1
      const commitLock = await stageProjectCurrencyLock(tx, companyId, projectId)

      tx.set(counterRef, { next: next + 1 }, { merge: true })

      tx.set(releaseRef, {
        releaseNumber: formatRetentionReleaseNumber(next),
        status:        RR_STATUS.DRAFT,
        docType:       RR_DOC_TYPE,

        // Target invoice — the id is a SCALAR, which is what lets Firestore
        // rules get() the invoice and verify it is posted and the cap holds.
        // The two references are frozen snapshots so a register row renders
        // without reading the invoice document.
        supplierInvoiceId:     invoice.id,
        invoiceNumber:         invoice.invoiceNumber || '',
        supplierInvoiceNumber: invoice.supplierInvoiceNumber || '',

        // Supplier identity — frozen from the invoice, never re-read. A legacy
        // pre-Contacts invoice may carry supplierId: null and is never
        // backfilled (ADR-15).
        supplierId:   invoice.supplierId ?? null,
        supplierName: (invoice.supplierName || '').trim(),

        // Money. previouslyReleasedAmount is derived, never user-editable;
        // gstAmount is the cumulative rounding delta; releaseTotal is the cash
        // that becomes payable on the invoice.
        previouslyReleasedAmount: totals.previouslyReleasedAmount,
        amount:                   totals.amount,
        gstAmount:                totals.gstAmount,
        releaseTotal:             totals.releaseTotal,

        // The date the release was AGREED. Deliberately NOT a defects-liability
        // date, a contractual entitlement date, or a payment due date — none of
        // those is modelled in V1 (ADR-30).
        releaseDate: releaseDate || '',
        reason:      (reason || '').trim(),
        notes:       (notes || '').trim(),

        // Audit snapshot of the project currency at write time — never read for
        // display (the project currency is the display authority).
        currency: projectCurrency,
        revision: 1,

        // Lifecycle audit stamps. Rules require these null/'' at create.
        postedAt:   null,
        postedBy:   null,
        voidedAt:   null,
        voidedBy:   null,
        voidReason: '',

        externalRefs: {},

        createdAt: serverTimestamp(),
        createdBy: user.uid,
        updatedAt: serverTimestamp(),
        updatedBy: user.uid,
      })
      commitLock()
    })
    return releaseRef.id
  }, [companyId, projectId, user, projectCurrency, retentionReleases, retentionReleasesError])

  // Draft-only edits. The release number, currency, creation stamps, docType,
  // revision, and target invoice are never rewritten here — and rules reject an
  // update that changes any of them. The snapshot and GST are RECOMPUTED, so
  // re-saving a draft is also how a stale snapshot is refreshed after a sibling
  // release posts.
  const updateRetentionRelease = useCallback(async (release, { releaseDate, amount, reason, notes, invoice }) => {
    if (!companyId || !projectId || !user) throw new Error('Not authenticated')
    if (release.status !== RR_STATUS.DRAFT) throw new Error('Only draft retention releases can be edited')
    if (retentionReleasesError) {
      throw new Error('Retention releases could not be loaded, so the amount already released is unknown. Reload before editing this release.')
    }

    const validationError = validateReleaseDraft({
      supplierInvoiceId: release.supplierInvoiceId,
      amount, releaseDate, reason,
      invoices: invoice ? [invoice] : null,
      releases: retentionReleases,
      excludeReleaseId: release.id,
    })
    if (validationError) throw new Error(validationError)

    const previouslyReleased = releasedExGstForInvoice(retentionReleases, release.supplierInvoiceId, { excludeReleaseId: release.id })
    const totals = releaseTotals(previouslyReleased, amount)

    const ref = doc(db, 'companies', companyId, 'projects', projectId, 'retentionReleases', release.id)
    await updateDoc(ref, {
      previouslyReleasedAmount: totals.previouslyReleasedAmount,
      amount:                   totals.amount,
      gstAmount:                totals.gstAmount,
      releaseTotal:             totals.releaseTotal,
      releaseDate: releaseDate || '',
      reason:      (reason || '').trim(),
      notes:       (notes || '').trim(),
      updatedAt:   serverTimestamp(),
      updatedBy:   user.uid,
    })
  }, [companyId, projectId, user, retentionReleases, retentionReleasesError])

  // Posting is the FINANCIAL COMMIT POINT: from here the amount is part of the
  // invoice's derived payable basis and is settled by an ordinary Supplier
  // Payment. It is a status-only operation carrying no content change — the
  // figures that were reviewed are the ones committed — which is also why a
  // STALE snapshot must block rather than be silently corrected.
  const postRetentionRelease = useCallback(async (release, { invoices = null } = {}) => {
    if (!companyId || !projectId || !user) throw new Error('Not authenticated')
    if (retentionReleasesError) {
      throw new Error('Retention releases could not be loaded, so the amount already released is unknown. Reload before posting this release.')
    }

    const blocked = postBlockedReason(release, invoices, retentionReleases)
    if (blocked) throw new Error(blocked)

    const ref = doc(db, 'companies', companyId, 'projects', projectId, 'retentionReleases', release.id)
    await updateDoc(ref, {
      status:    RR_STATUS.POSTED,
      postedAt:  serverTimestamp(),
      postedBy:  user.uid,
      updatedAt: serverTimestamp(),
      updatedBy: user.uid,
    })
  }, [companyId, projectId, user, retentionReleases, retentionReleasesError])

  // Voiding is terminal and requires a non-whitespace reason — by this hook AND
  // by Firestore rules. Releases are never deleted (ADR-12): a voided release is
  // retained audit history (and remains currency-lock evidence) and simply
  // contributes zero to every derived figure from the next render. No reversal,
  // credit note, or adjustment document is created, and the supplier invoice is
  // not touched.
  const voidRetentionRelease = useCallback(async (release, voidReason) => {
    if (!companyId || !projectId || !user) throw new Error('Not authenticated')
    if (release.status === RR_STATUS.VOID) throw new Error('This retention release is already void')
    const reason = (voidReason || '').trim()
    if (!reason) throw new Error('Enter a reason for voiding this retention release')

    const ref = doc(db, 'companies', companyId, 'projects', projectId, 'retentionReleases', release.id)
    await updateDoc(ref, {
      status:     RR_STATUS.VOID,
      voidedAt:   serverTimestamp(),
      voidedBy:   user.uid,
      voidReason: reason,
      updatedAt:  serverTimestamp(),
      updatedBy:  user.uid,
    })
  }, [companyId, projectId, user])

  return {
    retentionReleases,
    retentionReleasesLoading,
    retentionReleasesError,
    createRetentionRelease,
    updateRetentionRelease,
    postRetentionRelease,
    voidRetentionRelease,
  }
}
