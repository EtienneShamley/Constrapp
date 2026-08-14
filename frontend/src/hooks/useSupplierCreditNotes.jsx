import { useEffect, useState, useCallback, useMemo } from 'react'
import {
  collection, doc, onSnapshot, query, orderBy,
  runTransaction, updateDoc, serverTimestamp,
} from 'firebase/firestore'
import { db } from '../lib/firebase'
import { useAuth } from './useAuth'
import { useCompany } from './useCompany'
import { stageProjectCurrencyLock } from './projectCurrencyLock'
import {
  SCN_STATUS, SCN_DOC_TYPE, SUPPLIER_CREDIT_NOTE_COUNTER_ID,
  canTransition, creditNoteTotals, formatSupplierCreditNoteNumber,
  validateCreditNoteDraft, postBlockedReason,
} from '../lib/supplierCreditNotes'

// ── Supplier Credit Notes (accounts payable — reduction facts) ───────────────
//
// The reduction-side register: supplier credits recorded against posted
// Supplier Invoices. Reads are restricted to internal financial roles by
// Firestore rules.
//
// This hook writes ONLY supplier credit note documents (plus the company-wide
// counter and the project currency ratchet, both inside the create
// transaction). It NEVER mutates the target supplier invoice — no credited
// total, no back-reference, no status change. Every net figure (Invoiced,
// Actual, Remaining Payable, AP ageing, Forecast Cash Out) is derived at read
// time in lib/supplierCreditNotes.js and its consumers.
//
// LIFECYCLE NOTE. The credit-note lifecycle is enforced by Firestore rules to
// the ADR-22 standard, and the rules additionally get() the TARGET invoice on
// create and draft edit: it must exist, be posted, carry zero retention, match
// the credit's supplier and currency, and its payableTotal must cover this
// credit's grossTotal. The checks below are the UX mirror — the rules are the
// boundary. The CUMULATIVE cap across sibling credit notes is app-enforced
// only (docs/SECURITY.md → Deferred Control 25).
export function useSupplierCreditNotes(projectId) {
  const { user }    = useAuth()
  const { company } = useCompany()

  const companyId = company?.id ?? null

  // Live subscription state, tagged with the target (`key`) it belongs to. The
  // effect is subscription-only: state is written ONLY from the onSnapshot
  // callbacks, never synchronously in the effect body, so loading/error are
  // derived at render time below (matching useClientInvoices).
  const [snap, setSnap] = useState({ key: null, creditNotes: [], error: false })

  useEffect(() => {
    if (!companyId || !projectId) return undefined

    const key = `${companyId}/${projectId}`
    const ref = collection(db, 'companies', companyId, 'projects', projectId, 'supplierCreditNotes')
    const q   = query(ref, orderBy('createdAt', 'desc'))

    const unsubscribe = onSnapshot(
      q,
      (querySnap) => setSnap({
        key,
        creditNotes: querySnap.docs.map(d => ({ id: d.id, ...d.data() })),
        error: false,
      }),
      // Read error (most often a rules rejection for a non-financial role) —
      // degrade gracefully rather than crashing the page.
      () => setSnap({ key, creditNotes: [], error: true }),
    )
    return unsubscribe
  }, [companyId, projectId])

  const targetKey = companyId && projectId ? `${companyId}/${projectId}` : null
  const settled = targetKey !== null && snap.key === targetKey
  // Memoised so the write callbacks below (which validate against the live
  // list) keep stable dependencies across renders.
  const supplierCreditNotes = useMemo(
    () => (settled ? snap.creditNotes : []),
    [settled, snap.creditNotes],
  )
  const supplierCreditNotesLoading = targetKey !== null && !settled
  const supplierCreditNotesError = settled ? snap.error : false

  // Creates a DRAFT credit note against ONE posted, retention-free supplier
  // invoice. The company-wide counter is read and incremented in the same
  // transaction as the credit-note write (ADR-5), and the project currency
  // ratchet is staged in the same transaction (ADR-21).
  //
  // `invoice` is the full target supplier invoice document: its identity is
  // FROZEN here (supplierInvoiceId + both invoice references + supplier
  // snapshot + currency) and can never change afterwards — rules reject any
  // update that touches those fields. Retargeting is a void plus a new credit
  // note. The credit's `currency` is frozen FROM THE INVOICE (they are the
  // same value on any post-ratchet project; rules require the match).
  const createSupplierCreditNote = useCallback(async ({
    invoice, supplierCreditReference, creditDate, reason, lineItems, notes,
  }) => {
    if (!companyId || !projectId || !user) throw new Error('Not authenticated')

    const validationError = validateCreditNoteDraft(
      { supplierInvoiceId: invoice?.id, creditDate, reason, lineItems },
      { invoice, creditNotes: supplierCreditNotes },
    )
    if (validationError) throw new Error(validationError)

    const totals = creditNoteTotals(lineItems)

    const counterRef    = doc(db, 'companies', companyId, 'counters', SUPPLIER_CREDIT_NOTE_COUNTER_ID)
    const creditNoteRef = doc(collection(db, 'companies', companyId, 'projects', projectId, 'supplierCreditNotes'))

    await runTransaction(db, async (tx) => {
      const counterSnap = await tx.get(counterRef)
      const next = counterSnap.exists() ? counterSnap.data().next : 1
      // The currency ratchet is staged during the transaction's READ phase and
      // committed below, so this credit note and the project lock succeed or
      // fail together. Firestore requires all transaction reads before any
      // writes.
      const commitLock = await stageProjectCurrencyLock(tx, companyId, projectId)

      tx.set(counterRef, { next: next + 1 }, { merge: true })

      tx.set(creditNoteRef, {
        creditNumber: formatSupplierCreditNoteNumber(next),
        status:       SCN_STATUS.DRAFT,
        docType:      SCN_DOC_TYPE.CREDIT_NOTE,

        // Target identity — FROZEN at creation (the supplierName/costCodeName
        // idiom) and core-preserved by rules on every later update.
        supplierInvoiceId:     invoice.id,
        invoiceNumber:         invoice.invoiceNumber || '',
        supplierInvoiceNumber: invoice.supplierInvoiceNumber || '',
        supplierId:            invoice.supplierId ?? null,
        supplierName:          (invoice.supplierName || '').trim(),

        // The supplier's own credit-note reference (e.g. CN-1042) — what AP
        // staff reconcile against. '' when the supplier gave none.
        supplierCreditReference: supplierCreditReference?.trim() || '',

        creditDate: creditDate || '',
        reason:     (reason || '').trim(),

        // Money — ex-GST canonical, per-line GST; headers derive from the
        // lines. No retention and no payable/gross split: a credit note's
        // gross IS its payable effect (retained invoices cannot be credited).
        lineItems,
        subtotal:   totals.subtotal,
        gstTotal:   totals.gstTotal,
        grossTotal: totals.grossTotal,

        // Audit snapshot, frozen from the target invoice so the rules
        // currency match holds by construction. Never read for rendering —
        // the project currency remains the display authority.
        currency: invoice.currency,
        revision: 1,

        notes: notes?.trim() || '',

        // Lifecycle audit stamps. Rules require these to be null at create.
        postedAt:   null,
        postedBy:   null,
        voidedAt:   null,
        voidedBy:   null,
        voidReason: '',

        // Reserved for future modules (Storage, accounting sync).
        attachments:  [],
        externalRefs: {},

        createdAt: serverTimestamp(),
        createdBy: user.uid,
        updatedAt: serverTimestamp(),
        updatedBy: user.uid,
      })
      commitLock()
    })
    return creditNoteRef.id
  }, [companyId, projectId, user, supplierCreditNotes])

  // Draft-only edits. The target reference and supplier snapshot are NEVER
  // written here — and Firestore rules reject an update that changes any of
  // them (or the credit number, currency, docType, revision, creation stamps).
  // `invoice` is the frozen target's current document, for validation and the
  // rules-mirrored payable cap.
  const updateSupplierCreditNote = useCallback(async (creditNote, {
    invoice, supplierCreditReference, creditDate, reason, lineItems, notes,
  }) => {
    if (!companyId || !projectId || !user) throw new Error('Not authenticated')
    if (creditNote.status !== SCN_STATUS.DRAFT) throw new Error('Only draft credit notes can be edited')

    const validationError = validateCreditNoteDraft(
      { supplierInvoiceId: creditNote.supplierInvoiceId, creditDate, reason, lineItems },
      { invoice, creditNotes: supplierCreditNotes, excludeCreditNoteId: creditNote.id },
    )
    if (validationError) throw new Error(validationError)

    const totals = creditNoteTotals(lineItems)
    const ref = doc(db, 'companies', companyId, 'projects', projectId, 'supplierCreditNotes', creditNote.id)

    await updateDoc(ref, {
      supplierCreditReference: supplierCreditReference?.trim() || '',
      creditDate: creditDate || '',
      reason:     (reason || '').trim(),
      lineItems,
      subtotal:   totals.subtotal,
      gstTotal:   totals.gstTotal,
      grossTotal: totals.grossTotal,
      notes:      notes?.trim() || '',
      updatedAt:  serverTimestamp(),
      updatedBy:  user.uid,
    })
  }, [companyId, projectId, user, supplierCreditNotes])

  // Posting is a SEPARATE operation performed after the draft is saved — it
  // never carries content changes. Firestore rules permit this update to touch
  // only status/postedAt/postedBy/updatedAt/updatedBy. The target and
  // cumulative checks are re-run here against CURRENT data: the invoice may
  // have been cancelled, or a sibling credit posted, since the draft was
  // saved. (The cumulative re-check is client-side only — Deferred Control 25.)
  const postSupplierCreditNote = useCallback(async (creditNote, { invoices }) => {
    if (!companyId || !projectId || !user) throw new Error('Not authenticated')
    if (!canTransition(creditNote.status, SCN_STATUS.POSTED)) {
      throw new Error(`Cannot post a ${creditNote.status} credit note`)
    }
    const blocked = postBlockedReason(creditNote, invoices, supplierCreditNotes)
    if (blocked) throw new Error(blocked)

    const ref = doc(db, 'companies', companyId, 'projects', projectId, 'supplierCreditNotes', creditNote.id)
    await updateDoc(ref, {
      status:    SCN_STATUS.POSTED,
      postedAt:  serverTimestamp(),
      postedBy:  user.uid,
      updatedAt: serverTimestamp(),
      updatedBy: user.uid,
    })
  }, [companyId, projectId, user, supplierCreditNotes])

  // Voiding is terminal and available from draft or posted. A non-whitespace
  // reason is required — by this hook AND by Firestore rules. Financial
  // documents are never deleted (ADR-12); the credit number is retained, so a
  // voided credit note leaves a visible, intentional gap in the SCN sequence.
  // Voiding restores every derived figure at the next render — no reversal
  // document is written.
  const voidSupplierCreditNote = useCallback(async (creditNote, voidReason) => {
    if (!companyId || !projectId || !user) throw new Error('Not authenticated')
    if (!canTransition(creditNote.status, SCN_STATUS.VOID)) {
      throw new Error(`Cannot void a ${creditNote.status} credit note`)
    }
    const reasonText = (voidReason || '').trim()
    if (!reasonText) throw new Error('Enter a reason for voiding this credit note')

    const ref = doc(db, 'companies', companyId, 'projects', projectId, 'supplierCreditNotes', creditNote.id)
    await updateDoc(ref, {
      status:     SCN_STATUS.VOID,
      voidedAt:   serverTimestamp(),
      voidedBy:   user.uid,
      voidReason: reasonText,
      updatedAt:  serverTimestamp(),
      updatedBy:  user.uid,
    })
  }, [companyId, projectId, user])

  return {
    supplierCreditNotes,
    supplierCreditNotesLoading,
    supplierCreditNotesError,
    createSupplierCreditNote,
    updateSupplierCreditNote,
    postSupplierCreditNote,
    voidSupplierCreditNote,
  }
}
