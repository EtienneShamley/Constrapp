import { useEffect, useState, useCallback } from 'react'
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
import { roundMoney } from '../lib/purchaseOrders'
import {
  BID_STATUS, TENDER_STATUS, canBidTransition, validateBidDraft,
} from '../lib/tenders'

// ── Tender Bids ───────────────────────────────────────────────────────────────
//
// A tender bid is a MANUAL TRANSCRIPTION of a bid received from a supplier/
// subcontractor contact against an ISSUED tender package, priced per cost code
// (ex-GST; no GST fields — comparison is ex-GST). One project-level collection
// referencing tenderPackageId (the progressClaims→PO idiom). Reads are
// restricted to internal financial roles by Firestore rules — a bid IS
// competitor pricing.
//
// ⚠️ NO STORED bidTotal. Bids store lineItems only; every total is derived at
// read time through lib/tenders.js → assessBid(), whose validity gate makes a
// malformed document fail safely instead of being trusted (the Credit Notes
// header-vs-lines lesson).
//
// This hook writes ONLY tender bid documents (plus the project currency
// ratchet inside the create transaction). It NEVER mutates packages, budget
// lines, POs, claims, invoices, variations, forecast lines, or cash-flow lines.
//
// LIFECYCLE NOTE. Rules enforce: create as 'received' only, against a parent
// package IN THIS PROJECT that is 'issued', with a real supplier/subcontractor
// contact and matching name snapshot; edits and voids only while the package
// stays issued (bids freeze on award/cancel); void terminal. The checks below
// are the UX mirror — the rules are the boundary.
export function useTenderBids(projectId) {
  const { user }    = useAuth()
  const { company } = useCompany()
  const { project } = useProject(projectId)

  const companyId = company?.id ?? null

  // The currency this project reports in — project.currency, falling back to
  // the company base currency and finally AUD.
  const projectCurrency = resolveProjectCurrency(project, company)

  // Live subscription state, tagged with the target (`key`) it belongs to —
  // subscription-only effect, matching useClientReceipts.
  const [snap, setSnap] = useState({ key: null, bids: [], error: false })

  useEffect(() => {
    if (!companyId || !projectId) return undefined

    const key = `${companyId}/${projectId}`
    const ref = collection(db, 'companies', companyId, 'projects', projectId, 'tenderBids')
    const q   = query(ref, orderBy('createdAt', 'desc'))

    const unsubscribe = onSnapshot(
      q,
      (querySnap) => setSnap({
        key,
        bids: querySnap.docs.map(d => ({ id: d.id, ...d.data() })),
        error: false,
      }),
      // Read error (most often a rules rejection for a non-financial role) —
      // degrade gracefully rather than crashing the page.
      () => setSnap({ key, bids: [], error: true }),
    )
    return unsubscribe
  }, [companyId, projectId])

  const targetKey = companyId && projectId ? `${companyId}/${projectId}` : null
  const settled = targetKey !== null && snap.key === targetKey
  const tenderBids = settled ? snap.bids : []
  const tenderBidsLoading = targetKey !== null && !settled
  const tenderBidsError = settled ? snap.error : false

  // Normalises entered lines into the stored shape: frozen cost-code name
  // snapshots resolved from the PACKAGE's own frozen list (never re-read from
  // live cost codes), trimmed descriptions, amounts rounded to cents.
  const buildLineItems = (lineItems, tenderPackage) => {
    const nameById = new Map(
      (tenderPackage?.costCodes ?? []).map(cc => [cc.costCodeId, cc.costCodeName]),
    )
    return (lineItems ?? []).map(li => ({
      costCodeId:   li.costCodeId,
      costCodeName: nameById.get(li.costCodeId) ?? (li.costCodeName || ''),
      description:  (li.description || '').trim(),
      amount:       roundMoney(Number(li.amount)),
    }))
  }

  // Records a RECEIVED bid (no draft state — a bid is a transcription of an
  // external document, not an authored document with a commit point). A bid
  // carries ex-GST amounts in the project currency, so it is MONETARY EVIDENCE:
  // the project currency ratchet is staged in the same transaction (ADR-21) —
  // the bid and the lock commit or roll back together. There is no counter and
  // no sequential number.
  const createTenderBid = useCallback(async ({
    tenderPackage, bidderContactId, bidderName,
    bidDate, bidderRef, lineItems, exclusions, notes,
    contacts = null, bids = null,
  }) => {
    if (!companyId || !projectId || !user) throw new Error('Not authenticated')

    const validationError = validateBidDraft({
      tenderPackage, bidderContactId, bidderName, bidDate, lineItems, contacts, bids,
    })
    if (validationError) throw new Error(validationError)

    const bidRef = doc(collection(db, 'companies', companyId, 'projects', projectId, 'tenderBids'))

    await runTransaction(db, async (tx) => {
      // The currency ratchet is staged during the transaction's READ phase and
      // committed below, so this bid and the project lock succeed or fail
      // together. Firestore requires all transaction reads before any writes.
      const commitLock = await stageProjectCurrencyLock(tx, companyId, projectId)

      tx.set(bidRef, {
        tenderPackageId: tenderPackage.id,
        // FROZEN snapshot of the package number — rules require it to equal
        // the package's own.
        tenderNumber: tenderPackage.tenderNumber,

        status: BID_STATUS.RECEIVED,

        // Bidder identity — FROZEN at creation (rules require the name to
        // match the contact's displayName) and immutable afterwards: a
        // wrong-bidder entry is voided and re-recorded, never edited over.
        bidderContactId,
        bidderName: (bidderName || '').trim(),

        // The date the bid was received — informational, like closingDate.
        bidDate,
        bidderRef: (bidderRef || '').trim(),

        // Embedded per-cost-code lines (ADR-6 idiom), ex-GST, no GST fields.
        // ⚠️ NO bidTotal is stored — totals derive through assessBid().
        lineItems: buildLineItems(lineItems, tenderPackage),

        exclusions: (exclusions || '').trim(),
        notes:      (notes || '').trim(),

        // Audit snapshot of the currency this bid was priced in. The PROJECT
        // currency remains the display authority — this field is never read
        // for rendering, so a project can never show mixed currencies.
        currency: projectCurrency,
        revision: 1,

        // Void audit stamps. Rules require these to be null at create.
        voidedAt:   null,
        voidedBy:   null,
        voidReason: '',

        createdAt: serverTimestamp(),
        createdBy: user.uid,
        updatedAt: serverTimestamp(),
        updatedBy: user.uid,
      })
      commitLock()
    })
    return bidRef.id
  }, [companyId, projectId, user, projectCurrency])

  // Transcription corrections while the bid is received AND the parent package
  // is still issued. Bidder identity, package linkage, the tenderNumber
  // snapshot, currency, and creation stamps are never written here — and
  // Firestore rules reject an update that changes any of them, or any bid
  // write once the package leaves 'issued'.
  const updateTenderBid = useCallback(async (bid, {
    tenderPackage, bidDate, bidderRef, lineItems, exclusions, notes,
    bids = null,
  }) => {
    if (!companyId || !projectId || !user) throw new Error('Not authenticated')
    if (bid.status !== BID_STATUS.RECEIVED) throw new Error('Only received bids can be corrected')
    if (tenderPackage?.status !== TENDER_STATUS.ISSUED) {
      throw new Error('Bids freeze once the package is awarded or cancelled')
    }

    const validationError = validateBidDraft({
      tenderPackage,
      bidderContactId: bid.bidderContactId,
      bidderName:      bid.bidderName,
      bidDate, lineItems,
      bids, excludeBidId: bid.id,
    })
    if (validationError) throw new Error(validationError)

    const ref = doc(db, 'companies', companyId, 'projects', projectId, 'tenderBids', bid.id)
    await updateDoc(ref, {
      bidDate,
      bidderRef:  (bidderRef || '').trim(),
      lineItems:  buildLineItems(lineItems, tenderPackage),
      exclusions: (exclusions || '').trim(),
      notes:      (notes || '').trim(),
      updatedAt:  serverTimestamp(),
      updatedBy:  user.uid,
    })
  }, [companyId, projectId, user])

  // Voiding is terminal and permitted only while the parent package is still
  // issued (rules-enforced via get() on the package). A non-empty reason is
  // required — by this hook AND by Firestore rules. Bids are never deleted
  // (ADR-12): a voided bid stays visible for audit and remains currency-lock
  // evidence, but is excluded from every comparison calculation.
  const voidTenderBid = useCallback(async (bid, tenderPackage, voidReason) => {
    if (!companyId || !projectId || !user) throw new Error('Not authenticated')
    if (!canBidTransition(bid.status, BID_STATUS.VOID)) {
      throw new Error(`Cannot void a ${bid.status} bid`)
    }
    if (tenderPackage?.status !== TENDER_STATUS.ISSUED) {
      throw new Error('Bids freeze once the package is awarded or cancelled')
    }
    const reason = (voidReason || '').trim()
    if (!reason) throw new Error('Enter a reason for voiding this bid')

    const ref = doc(db, 'companies', companyId, 'projects', projectId, 'tenderBids', bid.id)
    await updateDoc(ref, {
      status:     BID_STATUS.VOID,
      voidedAt:   serverTimestamp(),
      voidedBy:   user.uid,
      voidReason: reason,
      updatedAt:  serverTimestamp(),
      updatedBy:  user.uid,
    })
  }, [companyId, projectId, user])

  return {
    tenderBids,
    tenderBidsLoading,
    tenderBidsError,
    createTenderBid,
    updateTenderBid,
    voidTenderBid,
  }
}
