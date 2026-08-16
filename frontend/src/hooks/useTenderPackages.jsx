import { useEffect, useState, useCallback } from 'react'
import {
  collection, doc, onSnapshot, query, orderBy,
  runTransaction, updateDoc, serverTimestamp,
} from 'firebase/firestore'
import { db } from '../lib/firebase'
import { useAuth } from './useAuth'
import { useCompany } from './useCompany'
import {
  TENDER_COUNTER_ID, TENDER_STATUS, formatTenderNumber,
  canTenderTransition, validateTenderPackageDraft, awardBlockedReason,
} from '../lib/tenders'

// ── Tender Packages ───────────────────────────────────────────────────────────
//
// A tender package is a SCOPE record — a name, free-text scope, and ≥1 selected
// cost codes put to market. It carries NO amounts and NO currency field, so
// creating one does NOT engage the project currency ratchet (the money lives on
// Tender Bids — see useTenderBids). Reads are restricted to internal financial
// roles by Firestore rules.
//
// This hook writes ONLY tender package documents (plus the company-wide counter
// inside the create transaction). It NEVER mutates budget lines, purchase
// orders, claims, invoices, variations, forecast lines, cash-flow lines, or the
// commercial baseline — an AWARD IS A DECISION RECORD ONLY and creates no PO
// and no financial document. Every displayed total is derived at read time in
// lib/tenders.js.
//
// LIFECYCLE NOTE. Like clientInvoices, the package lifecycle is ALSO enforced
// by Firestore rules: create is draft-only; issuing freezes name/description/
// scope/costCodes (only closingDate and notes stay editable while issued);
// awarding verifies the bid via get() and can happen once; cancel needs a
// reason; awarded/cancelled are terminal. The checks below are the UX mirror —
// the rules are the boundary.
export function useTenderPackages(projectId) {
  const { user }    = useAuth()
  const { company } = useCompany()

  const companyId = company?.id ?? null

  // Live subscription state, tagged with the target (`key`) it belongs to. The
  // effect is subscription-only: state is written ONLY from the onSnapshot
  // callbacks, never synchronously in the effect body, so loading/error are
  // derived at render time below (matching useClientReceipts).
  const [snap, setSnap] = useState({ key: null, packages: [], error: false })

  useEffect(() => {
    if (!companyId || !projectId) return undefined

    const key = `${companyId}/${projectId}`
    const ref = collection(db, 'companies', companyId, 'projects', projectId, 'tenderPackages')
    const q   = query(ref, orderBy('createdAt', 'desc'))

    const unsubscribe = onSnapshot(
      q,
      (querySnap) => setSnap({
        key,
        packages: querySnap.docs.map(d => ({ id: d.id, ...d.data() })),
        error: false,
      }),
      // Read error (most often a rules rejection for a non-financial role) —
      // degrade gracefully rather than crashing the page.
      () => setSnap({ key, packages: [], error: true }),
    )
    return unsubscribe
  }, [companyId, projectId])

  const targetKey = companyId && projectId ? `${companyId}/${projectId}` : null
  const settled = targetKey !== null && snap.key === targetKey
  const tenderPackages = settled ? snap.packages : []
  const tenderPackagesLoading = targetKey !== null && !settled
  const tenderPackagesError = settled ? snap.error : false

  // Creates a DRAFT tender package. The company-wide counter is read and
  // incremented in the same transaction as the package write (ADR-5), so a
  // failed create consumes no number. NO currency ratchet here — a package
  // holds scope and dates, not money (ADR-32 Part 2).
  const createTenderPackage = useCallback(async ({
    name, description, scope, costCodes, closingDate, notes,
  }) => {
    if (!companyId || !projectId || !user) throw new Error('Not authenticated')

    const validationError = validateTenderPackageDraft({ name, costCodes, closingDate })
    if (validationError) throw new Error(validationError)

    const counterRef = doc(db, 'companies', companyId, 'counters', TENDER_COUNTER_ID)
    const packageRef = doc(collection(db, 'companies', companyId, 'projects', projectId, 'tenderPackages'))

    await runTransaction(db, async (tx) => {
      const counterSnap = await tx.get(counterRef)
      const next = counterSnap.exists() ? counterSnap.data().next : 1

      tx.set(counterRef, { next: next + 1 }, { merge: true })

      tx.set(packageRef, {
        tenderNumber: formatTenderNumber(next),
        status:       TENDER_STATUS.DRAFT,

        name:        (name || '').trim(),
        description: (description || '').trim(),
        scope:       (scope || '').trim(),

        // Selected cost codes with FROZEN name snapshots (the costCodeName
        // idiom) — the package's join onto the cost-code spine.
        costCodes: costCodes.map(cc => ({
          costCodeId:   cc.costCodeId,
          costCodeName: cc.costCodeName,
        })),

        // ⚠️ INFORMATIONAL ONLY — nothing blocks a bid after this date.
        closingDate: closingDate || '',

        notes: (notes || '').trim(),

        // Award decision fields. NO awardTotal is stored, ever — the award
        // display value derives from the frozen awarded bid's lineItems.
        awardedBidId:      null,
        awardedBidderName: null,
        awardNotes:        '',
        cancelReason:      '',

        revision: 1,

        // Lifecycle audit stamps. Rules require these to be null at create.
        issuedAt:    null,
        issuedBy:    null,
        awardedAt:   null,
        awardedBy:   null,
        cancelledAt: null,
        cancelledBy: null,

        createdAt: serverTimestamp(),
        createdBy: user.uid,
        updatedAt: serverTimestamp(),
        updatedBy: user.uid,
      })
    })
    return packageRef.id
  }, [companyId, projectId, user])

  // Draft-only edits of the commercial content. The tender number and creation
  // stamps are never written here — and Firestore rules reject an update that
  // changes any of them, or any content edit after issue.
  const updateTenderPackage = useCallback(async (pkg, {
    name, description, scope, costCodes, closingDate, notes,
  }) => {
    if (!companyId || !projectId || !user) throw new Error('Not authenticated')
    if (pkg.status !== TENDER_STATUS.DRAFT) throw new Error('Only draft packages can be edited')

    const validationError = validateTenderPackageDraft({ name, costCodes, closingDate })
    if (validationError) throw new Error(validationError)

    const ref = doc(db, 'companies', companyId, 'projects', projectId, 'tenderPackages', pkg.id)
    await updateDoc(ref, {
      name:        (name || '').trim(),
      description: (description || '').trim(),
      scope:       (scope || '').trim(),
      costCodes: costCodes.map(cc => ({
        costCodeId:   cc.costCodeId,
        costCodeName: cc.costCodeName,
      })),
      closingDate: closingDate || '',
      notes:       (notes || '').trim(),
      updatedAt:   serverTimestamp(),
      updatedBy:   user.uid,
    })
  }, [companyId, projectId, user])

  // Issuing is a SEPARATE stamp-only operation — it freezes the commercial
  // scope. Rules permit this update to touch only status/issuedAt/issuedBy/
  // updatedAt/updatedBy, require issuedBy to be the caller, and require
  // issuedAt to equal the server request time.
  const issueTenderPackage = useCallback(async (pkg) => {
    if (!companyId || !projectId || !user) throw new Error('Not authenticated')
    if (!canTenderTransition(pkg.status, TENDER_STATUS.ISSUED)) {
      throw new Error(`Cannot issue a ${pkg.status} package`)
    }

    const ref = doc(db, 'companies', companyId, 'projects', projectId, 'tenderPackages', pkg.id)
    await updateDoc(ref, {
      status:    TENDER_STATUS.ISSUED,
      issuedAt:  serverTimestamp(),
      issuedBy:  user.uid,
      updatedAt: serverTimestamp(),
      updatedBy: user.uid,
    })
  }, [companyId, projectId, user])

  // The one permitted edit of an ISSUED package: closingDate and notes only
  // (the rules carve-out). Extending an informational closing date is routine
  // and must not force cancel-and-recreate; the commercial scope stays frozen.
  const updateIssuedTenderPackage = useCallback(async (pkg, { closingDate, notes }) => {
    if (!companyId || !projectId || !user) throw new Error('Not authenticated')
    if (pkg.status !== TENDER_STATUS.ISSUED) {
      throw new Error('Only issued packages take the closing-date/notes edit')
    }
    if (closingDate && !/^\d{4}-\d{2}-\d{2}$/.test(closingDate)) {
      throw new Error('Closing date must be a valid date (or left blank).')
    }

    const ref = doc(db, 'companies', companyId, 'projects', projectId, 'tenderPackages', pkg.id)
    await updateDoc(ref, {
      closingDate: closingDate || '',
      notes:       (notes || '').trim(),
      updatedAt:   serverTimestamp(),
      updatedBy:   user.uid,
    })
  }, [companyId, projectId, user])

  // AWARD — a commercial decision record, nothing more. Verifies (as UX; the
  // rules re-verify via get()) that the bid belongs to this package, is
  // received, and passes the read-time validity gate — the app refuses to
  // award a malformed bid. Stores the bid reference, the bidder-name snapshot
  // (rules require it to equal the bid's own), and the decision notes. NO
  // awardTotal, NO purchase order, NO budget/commitment/actual/forecast/
  // cash-flow write of any kind.
  const awardTenderPackage = useCallback(async (pkg, bid, awardNotes) => {
    if (!companyId || !projectId || !user) throw new Error('Not authenticated')
    const blocked = awardBlockedReason(pkg, bid)
    if (blocked) throw new Error(blocked)

    const ref = doc(db, 'companies', companyId, 'projects', projectId, 'tenderPackages', pkg.id)
    await updateDoc(ref, {
      status:            TENDER_STATUS.AWARDED,
      awardedBidId:      bid.id,
      awardedBidderName: bid.bidderName,
      awardNotes:        (awardNotes || '').trim(),
      awardedAt:         serverTimestamp(),
      awardedBy:         user.uid,
      updatedAt:         serverTimestamp(),
      updatedBy:         user.uid,
    })
  }, [companyId, projectId, user])

  // Cancelling is terminal and available from draft or issued. A non-empty
  // reason is required — by this hook AND by Firestore rules. Packages are
  // never deleted (ADR-12); the tender number is retained, so a cancelled
  // package leaves a visible, intentional gap in the sequence.
  const cancelTenderPackage = useCallback(async (pkg, cancelReason) => {
    if (!companyId || !projectId || !user) throw new Error('Not authenticated')
    if (!canTenderTransition(pkg.status, TENDER_STATUS.CANCELLED)) {
      throw new Error(`Cannot cancel a ${pkg.status} package`)
    }
    const reason = (cancelReason || '').trim()
    if (!reason) throw new Error('Enter a reason for cancelling this package')

    const ref = doc(db, 'companies', companyId, 'projects', projectId, 'tenderPackages', pkg.id)
    await updateDoc(ref, {
      status:       TENDER_STATUS.CANCELLED,
      cancelledAt:  serverTimestamp(),
      cancelledBy:  user.uid,
      cancelReason: reason,
      updatedAt:    serverTimestamp(),
      updatedBy:    user.uid,
    })
  }, [companyId, projectId, user])

  return {
    tenderPackages,
    tenderPackagesLoading,
    tenderPackagesError,
    createTenderPackage,
    updateTenderPackage,
    issueTenderPackage,
    updateIssuedTenderPackage,
    awardTenderPackage,
    cancelTenderPackage,
  }
}
