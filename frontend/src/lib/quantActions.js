import {
  QUANT_ERROR, QUANT_ERROR_MESSAGES, quantErrorKind, sameRevision,
  MEASUREMENT_KIND, MEASUREMENT_STATUS,
  buildCalibration, calibrationSnapshot, isValidCalibration,
  takeoffPageId, validatePageGeometry, validateMeasurementDraft, validatePoints, validateLabel, validateBoqLink,
  normalisePoints, measurementBoqItemId,
} from './quant'

// ── Guarded takeoff writes (Quant 1A, ADR-51) ────────────────────────────────
//
// Every write Quant makes is ONE Firestore transaction that refuses to write
// over a version the user has not seen — the PULSE 1B convention
// (lib/pulseAcknowledgementActions.js):
//
//   1. read the server copy INSIDE the transaction
//   2. compare its `revision` with the copy the UI rendered from (`seen`);
//      refuse with STALE on any mismatch, so another user's calibration or
//      geometry edit is never silently overwritten
//   3. validate the expected state on the SERVER copy (active, calibrated,
//      the revision not withdrawn is left to rules via get())
//   4. write the next revision (+1) with server stamps; createdAt/createdBy
//      and the source identity are never rewritten
//
// If the document changes between the read and the commit, Firestore aborts
// and re-runs the callback; the re-run re-reads, step 2 fails, and the write is
// REFUSED rather than re-applied. A resolved promise IS the confirmation —
// nothing reports "saved" before the server has committed.
//
// ⚠️ Rules ASSIST this guard (every update must carry exactly revision + 1);
// they do not PROVE it — a client bypassing the app can read and write +1
// itself (docs/SECURITY.md → Deferred Control 32).
//
// ⚠️ NOTHING HERE TOUCHES A FINANCIAL DOCUMENT. No BOQ item, budget line,
// forecast line, cash-flow line, baseline, PO, claim or invoice is read or
// written, and no currency lock is staged (a measurement holds no money).
// Quant 1B (ADR-52) adds ONE optional field, `boqItemId` — a LINK to a BOQ item
// (string | null). Writing the link is still a measurement write; rules verify
// that the target exists in the same project, is active and shares the cost
// code. Applying a quantity to that item is a separate, explicitly confirmed
// BOQ write in lib/boqActions.js — never a side effect of anything here.
//
// Firestore SDK functions are INJECTED (`runTransaction`, `serverTimestamp`)
// so this module imports no Firebase code: the hook passes the app SDK and the
// emulator suite passes the test SDK and exercises the real transactions.

export class QuantError extends Error {
  constructor(kind, message, cause) {
    super(message ?? QUANT_ERROR_MESSAGES[kind] ?? QUANT_ERROR_MESSAGES[QUANT_ERROR.UNKNOWN])
    this.name = 'QuantError'
    this.kind = kind
    if (cause) this.cause = cause
  }
}

async function guarded(runTransaction, db, body) {
  let outcome
  try {
    outcome = await runTransaction(db, body)
  } catch (err) {
    if (err instanceof QuantError) throw err
    throw new QuantError(quantErrorKind(err?.code), undefined, err)
  }
  if (outcome.kind) throw new QuantError(outcome.kind)
  return outcome
}

const pageIdentityFields = ({ drawingId, revisionId, page }) => ({ drawingId, revisionId, page })

// ── Pages ────────────────────────────────────────────────────────────────────

// Make sure the takeoff page document exists, WITHOUT calibrating it. Used
// before a COUNT is saved on a page nobody has calibrated. Returns the page as
// it now stands on the server ({ revision, calibrationRevision, calibration }).
// Creating the page is a separate commit from creating the measurement, on
// purpose: rules verify the page's existence with exists(), which sees only
// committed state — a page and its first measurement cannot share one commit.
export async function runEnsurePage({
  db, pageRef, identity, geometry, uid, runTransaction, serverTimestamp,
}) {
  if (!uid) throw new QuantError(QUANT_ERROR.PERMISSION)
  const id = takeoffPageId(identity?.drawingId, identity?.revisionId, identity?.page)
  if (!id) throw new QuantError(QUANT_ERROR.INVALID, 'The drawing page is not identified.')
  const geometryError = validatePageGeometry(geometry)
  if (geometryError) throw new QuantError(QUANT_ERROR.INVALID, geometryError)

  return guarded(runTransaction, db, async (tx) => {
    const snap = await tx.get(pageRef)
    if (snap.exists()) {
      const current = snap.data()
      return {
        kind: null, created: false,
        page: { id: snap.id, ...current },
      }
    }
    const doc = {
      ...pageIdentityFields(identity),
      source:       geometry.source,
      pageWidth:    geometry.pageWidth,
      pageHeight:   geometry.pageHeight,
      pageRotation: geometry.pageRotation,
      calibration:         null,
      calibrationRevision: 0,
      calibratedAt: null,
      calibratedBy: null,
      revision:  1,
      createdAt: serverTimestamp(),
      createdBy: uid,
      updatedAt: serverTimestamp(),
      updatedBy: uid,
    }
    tx.set(pageRef, doc)
    return { kind: null, created: true, page: { id, ...doc, revision: 1, calibrationRevision: 0 } }
  })
}

// Save (or replace) the page's calibration. `seenPage` is the page document as
// rendered, or null when the user saw none. A replacement bumps
// `calibrationRevision`, which is what flags every existing length/area on
// the page as needing review (lib/quant.js → calibrationReviewState). The
// caller has ALREADY obtained the user's explicit confirmation when
// measurements exist — this function never decides that.
export async function runSaveCalibration({
  db, pageRef, identity, geometry, draft, seenPage, uid, runTransaction, serverTimestamp,
}) {
  if (!uid) throw new QuantError(QUANT_ERROR.PERMISSION)
  const id = takeoffPageId(identity?.drawingId, identity?.revisionId, identity?.page)
  if (!id) throw new QuantError(QUANT_ERROR.INVALID, 'The drawing page is not identified.')
  const geometryError = validatePageGeometry(geometry)
  if (geometryError) throw new QuantError(QUANT_ERROR.INVALID, geometryError)
  const calibration = buildCalibration(draft)
  if (!calibration) throw new QuantError(QUANT_ERROR.INVALID, 'The calibration is not valid.')

  return guarded(runTransaction, db, async (tx) => {
    const snap = await tx.get(pageRef)
    if (!snap.exists()) {
      // Nothing exists and the user saw nothing: a first calibration. Seeing a
      // page that has since vanished cannot happen (delete is blocked) and is
      // refused as stale rather than re-created.
      if (seenPage) return { kind: QUANT_ERROR.STALE }
      tx.set(pageRef, {
        ...pageIdentityFields(identity),
        source:       geometry.source,
        pageWidth:    geometry.pageWidth,
        pageHeight:   geometry.pageHeight,
        pageRotation: geometry.pageRotation,
        calibration,
        calibrationRevision: 1,
        calibratedAt: serverTimestamp(),
        calibratedBy: uid,
        revision:  1,
        createdAt: serverTimestamp(),
        createdBy: uid,
        updatedAt: serverTimestamp(),
        updatedBy: uid,
      })
      return { kind: null, revision: 1, calibrationRevision: 1 }
    }
    const current = snap.data()
    if (!seenPage || !sameRevision(seenPage, current)) return { kind: QUANT_ERROR.STALE }
    const revision = current.revision + 1
    const calibrationRevision = Number(current.calibrationRevision ?? 0) + 1
    tx.update(pageRef, {
      calibration,
      calibrationRevision,
      calibratedAt: serverTimestamp(),
      calibratedBy: uid,
      revision,
      updatedAt: serverTimestamp(),
      updatedBy: uid,
    })
    return { kind: null, revision, calibrationRevision }
  })
}

// ── Measurements ─────────────────────────────────────────────────────────────

// Create ONE measurement on a page that already exists (see runEnsurePage).
// `seenPage` is the page as rendered — the calibration the user measured
// under; a page that changed since is refused, because the quantity shown was
// not the quantity that would be saved.
export async function runCreateMeasurement({
  db, pageRef, measurementRef, identity, draft, seenPage, uid, runTransaction, serverTimestamp,
}) {
  if (!uid) throw new QuantError(QUANT_ERROR.PERMISSION)
  const pageId = takeoffPageId(identity?.drawingId, identity?.revisionId, identity?.page)
  if (!pageId) throw new QuantError(QUANT_ERROR.INVALID, 'The drawing page is not identified.')
  const validationError = validateMeasurementDraft(draft)
  if (validationError) throw new QuantError(QUANT_ERROR.INVALID, validationError)
  if (!seenPage) throw new QuantError(QUANT_ERROR.STALE)

  const points = normalisePoints(draft.points)
  const needsScale = draft.kind !== MEASUREMENT_KIND.COUNT

  return guarded(runTransaction, db, async (tx) => {
    const pageSnap = await tx.get(pageRef)
    if (!pageSnap.exists()) return { kind: QUANT_ERROR.MISSING }
    const page = pageSnap.data()
    if (!sameRevision(seenPage, page)) return { kind: QUANT_ERROR.STALE }

    let calibration = null
    if (needsScale) {
      if (!isValidCalibration(page.calibration)) return { kind: QUANT_ERROR.UNCALIBRATED }
      calibration = calibrationSnapshot(page)
      if (!calibration) return { kind: QUANT_ERROR.UNCALIBRATED }
    }

    tx.set(measurementRef, {
      takeoffPageId: pageId,
      ...pageIdentityFields(identity),
      kind:   draft.kind,
      points,
      label:  String(draft.label).trim(),
      costCodeId:   draft.costCodeId,
      costCodeName: String(draft.costCodeName).trim(),
      // Optional BOQ link (ADR-52) — an identity only; written explicitly as
      // null when absent so every 1B document carries the key.
      boqItemId: measurementBoqItemId(draft),
      calibration,
      status: MEASUREMENT_STATUS.ACTIVE,
      voidReason: '',
      voidedAt: null,
      voidedBy: null,
      revision:  1,
      createdAt: serverTimestamp(),
      createdBy: uid,
      updatedAt: serverTimestamp(),
      updatedBy: uid,
    })
    return { kind: null, revision: 1, id: measurementRef.id }
  })
}

// Edit an ACTIVE measurement. `changes` may carry `points`, `label`,
// `costCodeId` + `costCodeName`, and `boqItemId` (a string to link or re-link,
// null to unlink — ADR-52). `calibration` is the page's CURRENT snapshot
// and is written ONLY when the caller passes it — a geometry edit or an
// explicit "reviewed under the current scale"; a rename or re-coding leaves
// the snapshot alone, so nothing is silently treated as reviewed.
//
// A cost-code change always invalidates an existing link (rules require the
// linked item to share the measurement's cost code). When the caller changes
// the code without saying what the link should become, the link is CLEARED in
// the same write — decided against the SERVER copy inside the transaction, so a
// link that appeared underneath is cleared too, never left dangling.
export async function runUpdateMeasurement({
  db, ref, seen, changes = {}, calibration, uid, runTransaction, serverTimestamp,
}) {
  if (!uid) throw new QuantError(QUANT_ERROR.PERMISSION)
  if (!seen) throw new QuantError(QUANT_ERROR.MISSING)

  const next = {}
  if (changes.points !== undefined) {
    const pointsError = validatePoints(seen.kind, changes.points)
    if (pointsError) throw new QuantError(QUANT_ERROR.INVALID, pointsError)
    next.points = normalisePoints(changes.points)
  }
  if (changes.label !== undefined) {
    const labelError = validateLabel(changes.label)
    if (labelError) throw new QuantError(QUANT_ERROR.INVALID, labelError)
    next.label = String(changes.label).trim()
  }
  if (changes.costCodeId !== undefined || changes.costCodeName !== undefined) {
    if (!String(changes.costCodeId ?? '').trim()) throw new QuantError(QUANT_ERROR.INVALID, 'Choose a cost code.')
    if (!String(changes.costCodeName ?? '').trim()) throw new QuantError(QUANT_ERROR.INVALID, 'The chosen cost code has no display name.')
    next.costCodeId = changes.costCodeId
    next.costCodeName = String(changes.costCodeName).trim()
  }
  if (changes.boqItemId !== undefined) {
    const linkError = validateBoqLink(changes.boqItemId)
    if (linkError) throw new QuantError(QUANT_ERROR.INVALID, linkError)
    next.boqItemId = changes.boqItemId === null ? null : String(changes.boqItemId).trim()
  }
  if (calibration !== undefined) {
    if (seen.kind === MEASUREMENT_KIND.COUNT) {
      next.calibration = null
    } else {
      if (!calibration || !isValidCalibration(calibration) || !Number.isInteger(calibration.revision)) {
        throw new QuantError(QUANT_ERROR.UNCALIBRATED)
      }
      next.calibration = {
        revision: calibration.revision,
        pageDistance: calibration.pageDistance,
        realDistance: calibration.realDistance,
        unit: calibration.unit,
      }
    }
  }
  if (Object.keys(next).length === 0) throw new QuantError(QUANT_ERROR.INVALID, 'Nothing to save.')

  return guarded(runTransaction, db, async (tx) => {
    const snap = await tx.get(ref)
    if (!snap.exists()) return { kind: QUANT_ERROR.MISSING }
    const current = snap.data()
    if (!sameRevision(seen, current)) return { kind: QUANT_ERROR.STALE }
    if (current.status !== MEASUREMENT_STATUS.ACTIVE) return { kind: QUANT_ERROR.INVALID }
    // Re-coding a LINKED measurement with no explicit link decision: clear
    // the link in this same write (see the block comment above).
    const write = { ...next }
    const recoded = write.costCodeId !== undefined && write.costCodeId !== current.costCodeId
    if (recoded && write.boqItemId === undefined && measurementBoqItemId(current)) write.boqItemId = null
    const revision = current.revision + 1
    tx.update(ref, { ...write, revision, updatedAt: serverTimestamp(), updatedBy: uid })
    return { kind: null, revision, linkCleared: write.boqItemId === null && measurementBoqItemId(current) !== null && next.boqItemId === undefined }
  })
}

// Void an ACTIVE measurement — terminal, reasoned, never deleted.
export async function runVoidMeasurement({ db, ref, seen, reason, uid, runTransaction, serverTimestamp }) {
  if (!uid) throw new QuantError(QUANT_ERROR.PERMISSION)
  if (!seen) throw new QuantError(QUANT_ERROR.MISSING)
  const voidReason = String(reason ?? '').trim()
  if (!voidReason) throw new QuantError(QUANT_ERROR.INVALID, 'Enter a reason for voiding this measurement.')

  return guarded(runTransaction, db, async (tx) => {
    const snap = await tx.get(ref)
    if (!snap.exists()) return { kind: QUANT_ERROR.MISSING }
    const current = snap.data()
    if (!sameRevision(seen, current)) return { kind: QUANT_ERROR.STALE }
    if (current.status !== MEASUREMENT_STATUS.ACTIVE) return { kind: QUANT_ERROR.INVALID }
    const revision = current.revision + 1
    tx.update(ref, {
      status: MEASUREMENT_STATUS.VOID,
      voidReason,
      voidedAt: serverTimestamp(),
      voidedBy: uid,
      revision,
      updatedAt: serverTimestamp(),
      updatedBy: uid,
    })
    return { kind: null, revision }
  })
}
