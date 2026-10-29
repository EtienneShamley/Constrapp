import { PoWriteError, PO_WRITE_ERROR, poWriteErrorKind } from './purchaseOrderActions'
import { TENDER_STATUS, BID_STATUS, assessBid } from './tenders'
import { PO_STATUS, formatPoNumber } from './purchaseOrders'

// ── Guarded "raise PO from award" transaction (M3-A, ADR-61) ────────────────
//
// ONE transaction, the lib/purchaseOrderActions.js convention (SDK injected,
// no Firebase import, exercised against the real rules by the emulator suite):
//
//   reads  — counter · package · bid · previously linked PO (re-raise only)
//            · project (currency-lock staging; a no-op once locked)
//   checks — package exists and is still AWARDED to the bid the user saw;
//            bid exists, is RECEIVED, belongs to the package, and its lines
//            are the lines the user reviewed (bids freeze at award, so a
//            difference means a direct write — STALE, never merged);
//            the bid passes the validity gate (INVALID otherwise);
//            the package's CURRENT link is empty, or names a CANCELLED PO
//            the caller re-read (ALREADY_RAISED otherwise — a draft, sent or
//            closed linked PO, or a link the caller did not know about)
//   writes — counter + 1 · the new DRAFT PO (built by the injected builder
//            from the SAME buildPurchaseOrderDocument the manual path uses)
//            · the package back-link · the currency lock
//
// All reads precede all writes. Firestore serialises transactions on the
// documents they read, so two concurrent raises against one package produce
// exactly one PO — the loser re-reads the committed link and refuses. A retry
// after a lost response finds the link the same way. An aborted commit lands
// nothing: no PO, no back-link, no counter increment (the counter is written
// in this transaction, not before it).
//
// Rules enforce the pairing independently (getAfter on both sides) and every
// create invariant of ADR-57; what they cannot see — that the PO LINES equal
// the bid lines and the subtotal equals the awarded value — is this module's
// and lib/awardToPo.js's (docs/SECURITY.md → Deferred Control 38).

export const AWARD_PO_ERROR = {
  ...PO_WRITE_ERROR,
  ALREADY_RAISED: 'already_raised',
}

export const AWARD_PO_ERROR_MESSAGES = {
  [AWARD_PO_ERROR.ALREADY_RAISED]: 'A purchase order has already been raised from this award. Reload the page to see it.',
  [AWARD_PO_ERROR.STALE]:          'This award changed since you loaded it. Reload the page, review it again and retry.',
  [AWARD_PO_ERROR.MISSING]:        'The awarded package or its winning bid no longer exists.',
  [AWARD_PO_ERROR.INVALID]:        'The awarded bid cannot be raised as it stands.',
}

const fail = (kind, message) => new PoWriteError(kind, message ?? AWARD_PO_ERROR_MESSAGES[kind])

const sameLines = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

// The exact package update a raise writes — status untouched, link + stamps.
export function backlinkUpdate({ poId, poNumber, uid, now }) {
  return {
    raisedPoId: poId, raisedPoNumber: poNumber, raisedPoAt: now, raisedPoBy: uid,
    updatedAt: now, updatedBy: uid,
  }
}

// `refs`: { counterRef, packageRef, bidRef, poRef, previousPoRef | null }
// `seen`: { pkg, bid } — the copies the user reviewed (ids required)
// `buildDocument({ poNumber, now })` → the PO document (the hook binds the
//   proposal, currency, uid and source keys into it)
// `stageCurrencyLock(tx)` → async, returns the commit callback (optional)
export async function runRaisePurchaseOrderFromAward({
  db, uid, runTransaction, serverTimestamp, refs, seen, buildDocument, stageCurrencyLock = null,
}) {
  if (!uid) throw fail(AWARD_PO_ERROR.PERMISSION)
  if (!seen?.pkg?.id || !seen?.bid?.id) throw fail(AWARD_PO_ERROR.MISSING)
  if (typeof buildDocument !== 'function') throw fail(AWARD_PO_ERROR.INVALID, 'No purchase order builder was supplied.')
  const { counterRef, packageRef, bidRef, poRef, previousPoRef = null } = refs ?? {}
  if (!counterRef || !packageRef || !bidRef || !poRef) throw fail(AWARD_PO_ERROR.INVALID, 'The raise transaction is missing a document reference.')

  let outcome
  try {
    outcome = await runTransaction(db, async (tx) => {
      // ── reads ──
      const counterSnap = await tx.get(counterRef)
      const pkgSnap = await tx.get(packageRef)
      if (!pkgSnap.exists()) return { kind: AWARD_PO_ERROR.MISSING }
      const pkg = { id: pkgSnap.id, ...pkgSnap.data() }
      if (pkg.status !== TENDER_STATUS.AWARDED || pkg.awardedBidId !== seen.bid.id) {
        return { kind: AWARD_PO_ERROR.STALE, message: `${seen.pkg.tenderNumber || 'This package'} is ${pkg.status === TENDER_STATUS.AWARDED ? 'awarded to a different bid' : `now ${pkg.status}`}. Reload the page and review it again.` }
      }

      const bidSnap = await tx.get(bidRef)
      if (!bidSnap.exists()) return { kind: AWARD_PO_ERROR.MISSING }
      const bid = { id: bidSnap.id, ...bidSnap.data() }
      if (bid.status !== BID_STATUS.RECEIVED || bid.tenderPackageId !== pkg.id) return { kind: AWARD_PO_ERROR.STALE }
      if (bid.bidderContactId !== seen.bid.bidderContactId || bid.bidderName !== seen.bid.bidderName || !sameLines(bid.lineItems, seen.bid.lineItems)) {
        return { kind: AWARD_PO_ERROR.STALE, message: 'The awarded bid on the server differs from the one you reviewed. Reload the page and review it again.' }
      }
      if (!assessBid(bid, pkg).valid) return { kind: AWARD_PO_ERROR.INVALID }

      // The current link decides: empty → raise; a CANCELLED PO the caller
      // re-read → re-raise; anything else → already raised.
      const currentPoId = pkg.raisedPoId ?? null
      if (currentPoId) {
        if (!previousPoRef || previousPoRef.id !== currentPoId) {
          return { kind: AWARD_PO_ERROR.ALREADY_RAISED, message: `${pkg.raisedPoNumber || 'A purchase order'} has already been raised from this award. Reload the page to see it.` }
        }
        const prevSnap = await tx.get(previousPoRef)
        if (!prevSnap.exists()) return { kind: AWARD_PO_ERROR.ALREADY_RAISED, message: `${pkg.raisedPoNumber || 'A purchase order'} is linked to this award but could not be read. Reload the page.` }
        const prev = prevSnap.data()
        if (prev.status !== PO_STATUS.CANCELLED) {
          return { kind: AWARD_PO_ERROR.ALREADY_RAISED, message: `${prev.poNumber || pkg.raisedPoNumber} has already been raised from this award and is ${prev.status}. Cancel it before raising another.` }
        }
      }

      const commitLock = stageCurrencyLock ? await stageCurrencyLock(tx) : () => {}

      // ── writes ──
      const next = counterSnap.exists() ? counterSnap.data().next : 1
      const poNumber = formatPoNumber(next)
      const now = serverTimestamp()
      tx.set(counterRef, { next: next + 1 }, { merge: true })
      tx.set(poRef, buildDocument({ poNumber, now }))
      tx.update(packageRef, backlinkUpdate({ poId: poRef.id, poNumber, uid, now }))
      commitLock()
      return { kind: null, poId: poRef.id, poNumber }
    })
  } catch (err) {
    if (err instanceof PoWriteError) throw err
    throw new PoWriteError(poWriteErrorKind(err?.code), undefined, err)
  }
  if (outcome.kind) throw fail(outcome.kind, outcome.message)
  return outcome
}
