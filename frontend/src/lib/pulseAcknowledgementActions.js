import {
  ACK_STATUS, ACK_ERROR, ACK_ERROR_MESSAGES,
  acknowledgementErrorKind, sameAcknowledgementVersion,
  normaliseEvidenceKeys, EVIDENCE_KEY_LIMIT,
} from './pulseAttention'

// ── Guarded acknowledgement writes (PULSE 1B, ADR-49) ────────────────────────
//
// The two writes the acknowledgement workflow makes, each ONE Firestore
// transaction that refuses to write over a version the user has not seen:
//
//   1. read the acknowledgement document INSIDE the transaction (server copy)
//   2. compare its `revision` with the copy the button was rendered from
//      (`seen` — or null when the user saw no acknowledgement at all); refuse
//      on any mismatch, so another manager's acknowledgement is never
//      silently overwritten
//   3. validate the expected state on the server copy (withdraw needs ACTIVE)
//   4. write the next revision (+1) with the server stamps — createdAt /
//      createdBy are never rewritten
//
// If the document changes between the read and the commit, Firestore aborts
// and re-runs the callback; the re-run re-reads, step 2 now fails, and the
// write is REFUSED rather than re-applied. The callback has no side effect
// beyond the transaction, and the caller learns of success only after the
// server has committed — a resolved promise IS the confirmation.
//
// ⚠️ What this does NOT do. The revision check is rules-assisted (rules require
// exactly +1), not rules-proven: a client bypassing the app can still read and
// write +1 itself. Rules also cannot verify that `evidenceKeys` name real
// records or that the finding existed — docs/SECURITY.md → Deferred Control 31.
// And nothing here touches any financial document, figure or currency lock.
//
// Firestore SDK functions are INJECTED (`runTransaction`, `serverTimestamp`)
// so this module imports no Firebase code: the hook passes the app SDK and the
// emulator suite passes the test SDK and exercises the real transaction.

export class AcknowledgementError extends Error {
  constructor(kind, message, cause) {
    super(message ?? ACK_ERROR_MESSAGES[kind] ?? ACK_ERROR_MESSAGES[ACK_ERROR.UNKNOWN])
    this.name = 'AcknowledgementError'
    this.kind = kind
    if (cause) this.cause = cause
  }
}

const INDICATOR_ID_PATTERN = /^[a-zA-Z]+$/

async function guarded(runTransaction, db, body) {
  let outcome
  try {
    outcome = await runTransaction(db, body)
  } catch (err) {
    throw new AcknowledgementError(acknowledgementErrorKind(err?.code), undefined, err)
  }
  if (outcome.kind) throw new AcknowledgementError(outcome.kind)
  return outcome
}

// Acknowledge (or re-acknowledge) ONE indicator's finding. `seen` is the
// acknowledgement document as rendered, or null when none existed; `input` is
// already validated by lib/pulseAttention.js → validateAcknowledgementInput.
export async function runAcknowledge({
  db, ref, indicatorId, seen, evidenceKeys, note, reviewBy, uid,
  runTransaction, serverTimestamp,
}) {
  if (!uid) throw new AcknowledgementError(ACK_ERROR.PERMISSION)
  if (!INDICATOR_ID_PATTERN.test(indicatorId ?? '')) throw new AcknowledgementError(ACK_ERROR.INVALID)
  const keys = normaliseEvidenceKeys(evidenceKeys)
  if (keys.length > EVIDENCE_KEY_LIMIT) throw new AcknowledgementError(ACK_ERROR.INVALID)

  return guarded(runTransaction, db, async (tx) => {
    const snap = await tx.get(ref)
    const fields = {
      status: ACK_STATUS.ACTIVE,
      evidenceKeys: keys,
      note,
      reviewBy,
      acknowledgedAt: serverTimestamp(),
      acknowledgedBy: uid,
      withdrawnAt: null,
      withdrawnBy: null,
      updatedAt: serverTimestamp(),
      updatedBy: uid,
    }
    if (!snap.exists()) {
      // The user saw nothing and nothing exists: a first acknowledgement.
      // Seeing a document that has since vanished cannot happen (delete is
      // blocked) and is refused as stale rather than re-created.
      if (seen) return { kind: ACK_ERROR.STALE }
      tx.set(ref, {
        indicatorId,
        ...fields,
        revision: 1,
        createdAt: serverTimestamp(),
        createdBy: uid,
      })
      return { kind: null, revision: 1 }
    }
    const current = snap.data()
    // The user saw no acknowledgement but one exists now — someone else
    // acknowledged in between. Never overwrite it unseen.
    if (!seen || !sameAcknowledgementVersion(seen, current)) return { kind: ACK_ERROR.STALE }
    const revision = current.revision + 1
    tx.update(ref, { ...fields, revision })
    return { kind: null, revision }
  })
}

// Withdraw ONE active acknowledgement. Touches only the withdraw stamps, the
// status, the revision and the audit stamps — the note, review date and
// evidence keys stay as the record of what was acknowledged.
export async function runWithdraw({ db, ref, seen, uid, runTransaction, serverTimestamp }) {
  if (!uid) throw new AcknowledgementError(ACK_ERROR.PERMISSION)
  if (!seen) throw new AcknowledgementError(ACK_ERROR.MISSING)

  return guarded(runTransaction, db, async (tx) => {
    const snap = await tx.get(ref)
    if (!snap.exists()) return { kind: ACK_ERROR.MISSING }
    const current = snap.data()
    if (!sameAcknowledgementVersion(seen, current)) return { kind: ACK_ERROR.STALE }
    if (current.status !== ACK_STATUS.ACTIVE) return { kind: ACK_ERROR.INVALID }
    const revision = current.revision + 1
    tx.update(ref, {
      status: ACK_STATUS.WITHDRAWN,
      withdrawnAt: serverTimestamp(),
      withdrawnBy: uid,
      revision,
      updatedAt: serverTimestamp(),
      updatedBy: uid,
    })
    return { kind: null, revision }
  })
}
