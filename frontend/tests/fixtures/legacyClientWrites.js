// ── HISTORICAL CLIENT WRITE SHAPES — TEST FIXTURE ONLY ───────────────────────
//
// These are the write-shape builders and injected-SDK transaction runners the
// BROWSER used to run for progress claims (ADR-58 / ADR-63) and for the
// claim ↔ supplier-invoice pairing (ADR-40 / ADR-68), moved here VERBATIM from
// src/lib/progressClaimActions.js and src/lib/supplierInvoiceActions.js when
// those writes became trusted backend callables (ADR-93). No production module
// imports this file and none may: it exists only so the Rules suites can keep
// issuing exactly what the old client sent and prove that
// frontend/firestore.rules REFUSES it (`supplierInvoices` admits no client
// write; `progressClaims` admits only the content-free SUBMIT), and so the unit
// suites keep pinning the shape those denial tests rely on.
//
// Do NOT "modernise" these bodies. The comments inside them describe the world
// as it was when the browser made these writes; the authoritative behaviour
// now lives in functions/src/supplierFinance/ and src/lib/claimProcessing.js.
// What stays in production — the error classes and kinds, the revision
// arithmetic, the SUBMIT transition, the link classification — is imported
// from there, so a denial is asserted with the application's own error types.

import { SI_STATUS, SI_DOC_TYPE, SI_SOURCE, claimReconciliationError, invoiceTotals } from '../../src/lib/supplierInvoices'
import {
  CLAIM_STATUS, CLAIM_STATUS_LABELS, CLAIM_TRANSITION_STAMPS, canTransition, claimTotals,
  validateApprovedAmounts, buildClaimLine, claimedToDateCountError, validateClaimDraft,
  claimVariationLineIssue, CLAIM_VARIATION_LINE_ISSUE_LABELS, CLAIM_LINK_INITIAL,
  CLAIM_INVOICE_LINK, claimInvoiceLink,
} from '../../src/lib/progressClaims'
import { roundMoney } from '../../src/lib/purchaseOrders'
import { sourceLineIdentityError, isVariationOriginLine, sourceLineLabel } from '../../src/lib/sourceLine'
import { classifyCommitmentLines } from '../../src/lib/variations'
import {
  ClaimWriteError, CLAIM_WRITE_ERROR, claimWriteErrorKind, storedRevision, nextRevision,
} from '../../src/lib/progressClaimActions'
import {
  SupplierInvoiceWriteError, SI_WRITE_ERROR, existingInvoiceLinkError,
} from '../../src/lib/supplierInvoiceActions'

// ═════════════════════════════════════════════════════════════════════════════
// PROGRESS CLAIMS — formerly src/lib/progressClaimActions.js
// ═════════════════════════════════════════════════════════════════════════════

// ── Variation-origin source validation at CREATE (M3-B2, ADR-63) ─────────────
//
// Run by hooks/useProgressClaims.jsx INSIDE the create transaction over the
// SERVER copies of the PO and of every variation the lines name: each
// variation-origin line must be backed, right now, by a positive new-scope
// line of an approved, applied, scope-committed supplier variation on THIS PO
// with the same cost code and ceiling. Fail closed: the first problem names
// the line and the reason, and nothing is written. Rules cannot read the lines
// (DC40), so this transaction is the only source check these lines get.
export function variationSourceError(lineItems, { po, variations = [], variationIds = [] } = {}) {
  const byId = new Map()
  ;(variations ?? []).forEach((v, i) => { if (v?.id) byId.set(v.id, v); else if (variationIds[i]) byId.set(variationIds[i], null) })
  const lines = Array.isArray(lineItems) ? lineItems : []
  for (let i = 0; i < lines.length; i++) {
    const li = lines[i]
    if (!isVariationOriginLine(li)) continue
    const variation = byId.has(li.variationId) ? byId.get(li.variationId) : null
    const issue = claimVariationLineIssue(li, { variation, po, classify: classifyCommitmentLines })
    if (issue) {
      return `Line ${i + 1} (${sourceLineLabel(li)}): ${CLAIM_VARIATION_LINE_ISSUE_LABELS[issue] ?? issue} on the server, so the claim was not created. Review the variation and try again.`
    }
  }
  return null
}

const label = (status) => CLAIM_STATUS_LABELS[status] ?? String(status ?? 'unknown')

// The stale test shared by both transactions: the server copy must still be in
// the status the user acted on AND at the revision they reviewed.
function staleMessage(seen, live) {
  const name = seen.claimNumber || 'This progress claim'
  if (live.status !== seen.status) {
    return `${name} is now ${label(live.status)}, not ${label(seen.status)}. Review the latest version and retry — your entries are kept.`
  }
  if (storedRevision(live) !== storedRevision(seen)) {
    return `${name} was changed by another user since you loaded it. Review the latest version and retry — your entries are kept.`
  }
  return null
}

// ── Draft edit ───────────────────────────────────────────────────────────────

// The exact update a draft edit writes (hooks/useProgressClaims.jsx →
// updateProgressClaim), built over the STORED lines of `live` (ADR-37: the
// stored document is the sole authority for line identity; the caller supplies
// one cumulative claimed-to-date per stored line, in stored order). Exported so
// the unit suite can pin the contract without Firestore; `now` is the injected
// serverTimestamp(). Throws ClaimWriteError(INVALID) with the readable reason.
export function draftUpdate(live, { periodEnding, claimRef, notes, retention, claimedToDate } = {}, uid, now) {
  const countError = claimedToDateCountError(live?.lineItems, claimedToDate)
  if (countError) throw new ClaimWriteError(CLAIM_WRITE_ERROR.INVALID, countError)
  const lineItems = live.lineItems.map((storedLine, idx) =>
    buildClaimLine(storedLine, { claimedToDate: claimedToDate[idx] })
  )
  // Includes the source-line identity check (ADR-63): a stored line whose
  // identity is malformed or duplicated — e.g. one rewritten by a pre-M3-B2
  // client — is REFUSED here rather than re-attributed to PO line 0.
  const draftError = validateClaimDraft({ lineItems, retention, poId: live?.poId })
  if (draftError) throw new ClaimWriteError(CLAIM_WRITE_ERROR.INVALID, draftError)
  const totals = claimTotals(lineItems.map(li => li.claimedThisPeriod), retention)
  return {
    claimRef:        claimRef?.trim() || '',
    periodEnding:    periodEnding || '',
    lineItems,
    retention:       totals.retention,
    claimedSubtotal: totals.subtotal,
    claimedGst:      totals.gst,
    claimedTotal:    totals.total,
    notes:           notes?.trim() || '',
    revision:        nextRevision(live),
    updatedAt:       now,
    updatedBy:       uid,
  }
}

export async function runUpdateClaimDraft({ db, claimRef, seen, data, uid, runTransaction, serverTimestamp }) {
  if (!uid) throw new ClaimWriteError(CLAIM_WRITE_ERROR.PERMISSION)
  if (!seen?.id) throw new ClaimWriteError(CLAIM_WRITE_ERROR.MISSING)
  if (seen.status !== CLAIM_STATUS.DRAFT) {
    throw new ClaimWriteError(CLAIM_WRITE_ERROR.INVALID, 'Only draft claims can be edited')
  }
  // Validate against the copy the user reviewed BEFORE any read, so a plainly
  // invalid edit never opens a transaction; the same validation runs again
  // over the server copy below.
  draftUpdate(seen, data, uid, null)

  let outcome
  try {
    outcome = await runTransaction(db, async (tx) => {
      const snap = await tx.get(claimRef)
      if (!snap.exists()) return { kind: CLAIM_WRITE_ERROR.MISSING }
      const live = snap.data()
      const stale = staleMessage(seen, live)
      if (stale) return { kind: CLAIM_WRITE_ERROR.STALE, message: stale }
      if (live.status !== CLAIM_STATUS.DRAFT) return { kind: CLAIM_WRITE_ERROR.INVALID }
      tx.update(claimRef, draftUpdate(live, data, uid, serverTimestamp()))
      return { kind: null }
    })
  } catch (err) {
    if (err instanceof ClaimWriteError) throw err
    throw new ClaimWriteError(claimWriteErrorKind(err?.code), undefined, err)
  }
  if (outcome.kind) throw new ClaimWriteError(outcome.kind, outcome.message)
  return outcome
}

// ── Transitions ──────────────────────────────────────────────────────────────

// Certified amounts normalised to cents — one per line, in line order. The
// stored `claimedThisPeriod` is already whole-cent (buildClaimLine), so the
// per-line bound compares like with like and the approved header the rules
// check (Σ approved <= stored claimed subtotal, in cents) holds by construction.
export const normaliseApprovedAmounts = (approvedAmounts) =>
  (Array.isArray(approvedAmounts) ? approvedAmounts : []).map(a => roundMoney(Number(a) || 0))

// The exact update a transition writes — status, the transition's (at, by)
// pair, the two audit stamps and the revision; for APPROVE also the certified
// lines (every identity field carried from the stored line), the approved
// header (claimTotals over the certified amounts and the STORED retention —
// never rewritten) and the assessment notes; for REJECT the notes only when
// given. Exported so the unit suite can pin the contract without Firestore.
export function transitionUpdate(live, nextStatus, { approvedAmounts, assessmentNotes } = {}, uid, now) {
  const stamps = CLAIM_TRANSITION_STAMPS[nextStatus]
  if (!stamps) {
    throw new ClaimWriteError(CLAIM_WRITE_ERROR.INVALID, `A move to ${label(nextStatus)} is reserved and has no application path yet.`)
  }
  const base = { status: nextStatus, [stamps.at]: now, [stamps.by]: uid, revision: nextRevision(live), updatedAt: now, updatedBy: uid }

  if (nextStatus === CLAIM_STATUS.APPROVED) {
    const amounts = normaliseApprovedAmounts(approvedAmounts)
    const validationError = validateApprovedAmounts(live?.lineItems, amounts)
    if (validationError) throw new ClaimWriteError(CLAIM_WRITE_ERROR.INVALID, validationError)
    // ADR-63: certification freezes the lines forever, so a stored line set
    // whose source identities are malformed or duplicated is refused BEFORE it
    // can enter Actual — withdraw and re-raise the claim instead.
    const identityError = sourceLineIdentityError(live?.lineItems, { poId: live?.poId })
    if (identityError) throw new ClaimWriteError(CLAIM_WRITE_ERROR.INVALID, `${identityError}. Withdraw this claim and raise it again.`)
    const lineItems = live.lineItems.map((li, idx) => ({ ...li, approvedThisPeriod: amounts[idx] }))
    const totals = claimTotals(amounts, live.retention)
    return {
      ...base,
      lineItems,
      approvedSubtotal: totals.subtotal,
      approvedGst:      totals.gst,
      approvedTotal:    totals.total,
      assessmentNotes:  assessmentNotes?.trim() || '',
      // SHIELD 2A (ADR-68): approval INITIALISES the invoice link (present and
      // null) — a claim created by a pre-2A tab becomes new-format here, and
      // the FINAL rules require it. Workflow state only; never a figure.
      ...CLAIM_LINK_INITIAL,
    }
  }
  if (nextStatus === CLAIM_STATUS.REJECTED && assessmentNotes?.trim()) {
    return { ...base, assessmentNotes: assessmentNotes.trim() }
  }
  return base
}

export async function runTransitionClaim({ db, claimRef, seen, nextStatus, extras = {}, uid, runTransaction, serverTimestamp }) {
  if (!uid) throw new ClaimWriteError(CLAIM_WRITE_ERROR.PERMISSION)
  if (!seen?.id) throw new ClaimWriteError(CLAIM_WRITE_ERROR.MISSING)
  if (!canTransition(seen.status, nextStatus)) {
    throw new ClaimWriteError(CLAIM_WRITE_ERROR.INVALID, `Cannot move a ${label(seen.status)} progress claim to ${label(nextStatus)}.`)
  }
  // A reserved target, or invalid certified amounts, is refused BEFORE any
  // read; the amounts are validated again over the server copy below.
  transitionUpdate(seen, nextStatus, extras, uid, null)

  let outcome
  try {
    outcome = await runTransaction(db, async (tx) => {
      const snap = await tx.get(claimRef)
      if (!snap.exists()) return { kind: CLAIM_WRITE_ERROR.MISSING }
      const live = snap.data()
      const stale = staleMessage(seen, live)
      if (stale) return { kind: CLAIM_WRITE_ERROR.STALE, message: stale }
      if (!canTransition(live.status, nextStatus)) return { kind: CLAIM_WRITE_ERROR.INVALID }
      tx.update(claimRef, transitionUpdate(live, nextStatus, extras, uid, serverTimestamp()))
      return { kind: null }
    })
  } catch (err) {
    if (err instanceof ClaimWriteError) throw err
    throw new ClaimWriteError(claimWriteErrorKind(err?.code), undefined, err)
  }
  if (outcome.kind) throw new ClaimWriteError(outcome.kind, outcome.message)
  return outcome
}

// ═════════════════════════════════════════════════════════════════════════════
// CLAIM ↔ SUPPLIER-INVOICE PAIRING — formerly src/lib/supplierInvoiceActions.js
// ═════════════════════════════════════════════════════════════════════════════

export function supplierInvoiceWriteErrorKind(code) {
  switch (code) {
    case 'permission-denied':  return SI_WRITE_ERROR.PERMISSION
    case 'unavailable':
    case 'deadline-exceeded':  return SI_WRITE_ERROR.OFFLINE
    case 'not-found':          return SI_WRITE_ERROR.MISSING
    default:                   return SI_WRITE_ERROR.UNKNOWN
  }
}

const fail = (kind, message, extra) => ({ kind, message, ...extra })

// ── The documents ────────────────────────────────────────────────────────────

// The supplier invoice document exactly as hooks/useSupplierInvoices.jsx has
// always written it (ADR-40 shape: born draft, every lifecycle stamp null, the
// audit stamps on). `totals` is lib/supplierInvoices.js → invoiceTotals over
// the STORED lines; `now` is the injected serverTimestamp().
export function buildSupplierInvoiceDocument({
  invoiceNumber, source, supplierId, supplierName, poId, poNumber,
  progressClaimId, claimNumber, variationLineCount,
  supplierInvoiceNumber, invoiceDate, receivedDate, dueDate, paymentTerms,
  lineItems, totals, currency, notes, uid, now,
}) {
  return {
    invoiceNumber,
    supplierInvoiceNumber: supplierInvoiceNumber?.trim() || '',
    status:                SI_STATUS.DRAFT,
    docType:               SI_DOC_TYPE.INVOICE,
    source,

    // Supplier identity — snapshot from the PO/claim, never re-read.
    supplierId:   supplierId ?? null,
    supplierName: (supplierName || '').trim(),

    // Source references.
    poId:            poId ?? null,
    poNumber:        poNumber ?? null,
    progressClaimId: progressClaimId ?? null,
    claimNumber:     claimNumber ?? null,
    // ADR-63: how many stored lines are variation-origin (0 on a direct PO
    // invoice); rules bound it by the claim's and freeze it for life.
    variationLineCount,

    // Dates and terms.
    invoiceDate:  invoiceDate  || '',
    receivedDate: receivedDate || '',
    dueDate:      dueDate      || '',
    paymentTerms: paymentTerms ?? null,

    // Money — ex-GST canonical, per-line GST (see invoiceTotals).
    lineItems:      lineItems,
    retention:      totals.retention,
    retentionGst:   totals.retentionGst,
    retentionTotal: totals.retentionTotal,
    subtotal:       totals.subtotal,
    gstTotal:       totals.gstTotal,
    grossTotal:     totals.grossTotal,
    net:            totals.net,
    payableGst:     totals.payableGst,
    payableTotal:   totals.payableTotal,
    // Audit snapshot of the project currency at write time — never read for
    // display (the PROJECT currency is the authority).
    currency,
    revision:  1,

    notes: notes?.trim() || '',

    // Audit stamps — every one REQUIRED NULL at creation by rules (ADR-40).
    approvedAt:  null,
    approvedBy:  null,
    postedAt:    null,
    postedBy:    null,
    cancelledAt: null,
    cancelledBy: null,

    // ⚠️ paidAt is DEPRECATED IN PLACE (ADR-24): written null once, never
    // updated — payment state derives from posted Supplier Payments.
    // adjustsInvoiceId / attachments / externalRefs remain reserved.
    paidAt:           null,
    adjustsInvoiceId: null,
    attachments:      [],
    externalRefs:     {},

    createdAt: now,
    createdBy: uid,
    updatedAt: now,
    updatedBy: uid,
  }
}

// The claim LINK write (rules branch (e) on create, (g) on reconcile): the
// three link keys, the +1 revision and the audit stamps — nothing else.
export function claimLinkUpdate(live, { invoiceId, uid, now }) {
  return {
    supplierInvoiceId:       invoiceId,
    supplierInvoiceLinkedAt: now,
    supplierInvoiceLinkedBy: uid,
    revision:  nextRevision(live),
    updatedAt: now,
    updatedBy: uid,
  }
}

// The claim UNLINK write (rules branch (f), with the invoice's cancellation).
export function claimUnlinkUpdate(live, { uid, now }) {
  return {
    supplierInvoiceId:       null,
    supplierInvoiceLinkedAt: null,
    supplierInvoiceLinkedBy: null,
    revision:  nextRevision(live),
    updatedAt: now,
    updatedBy: uid,
  }
}

const sameId = (a, b) => (a ?? null) === (b ?? null)
const sameMoney = (a, b) => roundMoney(Number(a) || 0) === roundMoney(Number(b) || 0)

// The server copy of the claim, checked against the copy the user reviewed.
// Returns an outcome object on any problem, null when the claim can be linked
// to a new invoice carrying `invoice` (the identity the invoice will store).
export function claimPairingError(live, seen, invoice) {
  if (!live) return fail(SI_WRITE_ERROR.MISSING, 'This progress claim no longer exists.')
  const name = live.claimNumber || seen?.claimNumber || 'This progress claim'
  if (live.status !== CLAIM_STATUS.APPROVED) {
    return fail(SI_WRITE_ERROR.STALE, `${name} is no longer approved. Review the latest version and retry — your entries are kept.`)
  }
  const link = claimInvoiceLink(live)
  if (link.state === CLAIM_INVOICE_LINK.LINKED) {
    return fail(SI_WRITE_ERROR.ALREADY_INVOICED, undefined, { linkedInvoiceId: link.invoiceId })
  }
  if (link.state === CLAIM_INVOICE_LINK.LEGACY) return fail(SI_WRITE_ERROR.LEGACY_UNRECONCILED)
  if (link.state !== CLAIM_INVOICE_LINK.UNLINKED) {
    return fail(SI_WRITE_ERROR.INVALID, `${name} carries a malformed invoice link and cannot be invoiced until it is reviewed.`)
  }
  if (storedRevision(live) !== storedRevision(seen)) {
    return fail(SI_WRITE_ERROR.STALE, `${name} was changed by another user since you loaded it. Review the latest version and retry — your entries are kept.`)
  }
  // The identity the invoice will carry must be the claim's own (rules check
  // the same four on the server copy — this names the reason first).
  if (live.poId !== invoice.poId) {
    return fail(SI_WRITE_ERROR.INVALID, `${name} is a claim against ${live.poNumber || 'another purchase order'}, not ${invoice.poNumber || 'the selected one'}.`)
  }
  if (!sameId(live.supplierId, invoice.supplierId) || String(live.supplierName ?? '').trim() !== String(invoice.supplierName ?? '').trim()) {
    return fail(SI_WRITE_ERROR.INVALID, `${name} names a different supplier than this invoice.`)
  }
  if (live.claimNumber !== invoice.claimNumber) {
    return fail(SI_WRITE_ERROR.INVALID, `${name} is not the claim this invoice was built from.`)
  }
  // The certified figures the editor reconciled against must still be the
  // server's (approved money is frozen by rules, so a difference is a direct
  // write — STALE, never merged).
  const seenLines = Array.isArray(seen?.lineItems) ? seen.lineItems.length : null
  const liveLines = Array.isArray(live.lineItems) ? live.lineItems.length : null
  if (!sameMoney(live.approvedGst, seen?.approvedGst) || !sameMoney(live.approvedTotal, seen?.approvedTotal) || seenLines !== liveLines) {
    return fail(SI_WRITE_ERROR.STALE, `${name}'s certified figures on the server differ from the ones you reviewed. Review the latest version and retry.`)
  }
  return null
}

// ── Create ───────────────────────────────────────────────────────────────────
//
// `document` is everything buildSupplierInvoiceDocument needs except the
// number, the stamps and the totals (derived here over the STORED lines).
// `seenClaim` is the approved claim the editor reconciled against (null for a
// direct_po invoice); `refs.claimRef` must be given with it. `stageLock(tx)`
// is hooks/projectCurrencyLock.js → stageProjectCurrencyLock bound to the
// project (a read that returns the write callback), injected like the SDK.
export async function runCreateSupplierInvoice({
  db, refs, document, seenClaim = null, uid, runTransaction, serverTimestamp, stageLock, formatNumber,
}) {
  if (!uid) throw new SupplierInvoiceWriteError(SI_WRITE_ERROR.PERMISSION)
  const { counterRef, invoiceRef, claimRef = null } = refs
  const claimSourced = document.source === SI_SOURCE.PROGRESS_CLAIM
  if (claimSourced && (!seenClaim?.id || !claimRef)) {
    throw new SupplierInvoiceWriteError(SI_WRITE_ERROR.INVALID, 'Select the approved progress claim this invoice is raised from.')
  }
  const totals = invoiceTotals(document.lineItems, document.retention)

  let outcome
  try {
    outcome = await runTransaction(db, async (tx) => {
      // READS — all before any write.
      const counterSnap = await tx.get(counterRef)
      const next = counterSnap.exists() ? counterSnap.data().next : 1
      const commitLock = stageLock ? await stageLock(tx) : () => {}
      let liveClaim = null
      if (claimSourced) {
        const claimSnap = await tx.get(claimRef)
        liveClaim = claimSnap.exists() ? { id: claimSnap.id, ...claimSnap.data() } : null
        const pairingError = claimPairingError(liveClaim, seenClaim, document)
        if (pairingError) return pairingError
        // The existing reconciliation guard, against the SERVER certified
        // figures: the invoice must pay exactly the claim's GST and total.
        const reconcileError = claimReconciliationError(totals, { approvedGst: liveClaim.approvedGst, approvedTotal: liveClaim.approvedTotal })
        if (reconcileError) return fail(SI_WRITE_ERROR.INVALID, reconcileError)
      }

      // WRITES.
      const now = serverTimestamp()
      const invoiceNumber = formatNumber(next)
      tx.set(counterRef, { next: next + 1 }, { merge: true })
      tx.set(invoiceRef, buildSupplierInvoiceDocument({ ...document, invoiceNumber, totals, uid, now }))
      if (claimSourced) tx.update(claimRef, claimLinkUpdate(liveClaim, { invoiceId: invoiceRef.id, uid, now }))
      commitLock()
      return { kind: null, invoiceId: invoiceRef.id, invoiceNumber }
    })
  } catch (err) {
    if (err instanceof SupplierInvoiceWriteError) throw err
    throw new SupplierInvoiceWriteError(supplierInvoiceWriteErrorKind(err?.code), undefined, { cause: err })
  }
  if (outcome.kind) throw new SupplierInvoiceWriteError(outcome.kind, outcome.message, { linkedInvoiceId: outcome.linkedInvoiceId })
  return outcome
}

// ── Cancel ───────────────────────────────────────────────────────────────────
//
// draft | approved → cancelled. For a claim-sourced invoice whose claim links
// to IT, the claim is unlinked in the same commit (rules branch (f)); an
// invoice its claim does not link — legacy, or a claim that no longer exists
// — is cancelled exactly as before, with no link invented. Posted is terminal.
export async function runCancelSupplierInvoice({ db, invoiceRef, claimRef = null, seen, uid, runTransaction, serverTimestamp }) {
  if (!uid) throw new SupplierInvoiceWriteError(SI_WRITE_ERROR.PERMISSION)
  if (!seen?.id) throw new SupplierInvoiceWriteError(SI_WRITE_ERROR.MISSING)
  if (seen.status !== SI_STATUS.DRAFT && seen.status !== SI_STATUS.APPROVED) {
    throw new SupplierInvoiceWriteError(SI_WRITE_ERROR.INVALID, `Cannot cancel a ${seen.status} supplier invoice.`)
  }

  let outcome
  try {
    outcome = await runTransaction(db, async (tx) => {
      const invSnap = await tx.get(invoiceRef)
      if (!invSnap.exists()) return fail(SI_WRITE_ERROR.MISSING, 'This supplier invoice no longer exists.')
      const live = invSnap.data()
      if (live.status !== seen.status) {
        return fail(SI_WRITE_ERROR.STALE, `${live.invoiceNumber || 'This supplier invoice'} is now ${live.status}, not ${seen.status}. Review the latest version.`)
      }
      if (live.status !== SI_STATUS.DRAFT && live.status !== SI_STATUS.APPROVED) {
        return fail(SI_WRITE_ERROR.INVALID, `Cannot cancel a ${live.status} supplier invoice.`)
      }
      let liveClaim = null
      if (live.source === SI_SOURCE.PROGRESS_CLAIM && live.progressClaimId && claimRef) {
        const claimSnap = await tx.get(claimRef)
        if (claimSnap.exists()) liveClaim = claimSnap.data()
      }
      const now = serverTimestamp()
      const unlink = !!liveClaim && claimInvoiceLink(liveClaim).invoiceId === invoiceRef.id
      tx.update(invoiceRef, {
        status: SI_STATUS.CANCELLED, cancelledAt: now, cancelledBy: uid, updatedAt: now, updatedBy: uid,
      })
      if (unlink) tx.update(claimRef, claimUnlinkUpdate(liveClaim, { uid, now }))
      return { kind: null, unlinked: unlink }
    })
  } catch (err) {
    if (err instanceof SupplierInvoiceWriteError) throw err
    throw new SupplierInvoiceWriteError(supplierInvoiceWriteErrorKind(err?.code), undefined, { cause: err })
  }
  if (outcome.kind) throw new SupplierInvoiceWriteError(outcome.kind, outcome.message)
  return outcome
}

// ── Reconcile: link an EXISTING invoice ──────────────────────────────────────
//
// Verifies, on the SERVER copies, that the claim is approved, at the revision
// the user reviewed and currently unlinked (legacy key-absent or new-format
// null), and that the invoice is an ACTIVE claim-sourced invoice citing this
// claim, its PO and its supplier — then writes the link alone. Rules verify
// that one invoice too (branch (g)); neither can see its siblings, which is
// why the page offers this only from a settled, error-free register showing
// exactly one active invoice, and SHIELD lists the rest.
export async function runLinkExistingInvoice({ db, claimRef, invoiceRef, seenClaim, seenInvoice, uid, runTransaction, serverTimestamp }) {
  if (!uid) throw new SupplierInvoiceWriteError(SI_WRITE_ERROR.PERMISSION)
  if (!seenClaim?.id) throw new SupplierInvoiceWriteError(SI_WRITE_ERROR.MISSING, 'This progress claim no longer exists.')
  const preError = existingInvoiceLinkError({ ...seenClaim }, seenInvoice)
  if (preError) throw new SupplierInvoiceWriteError(SI_WRITE_ERROR.INVALID, preError)

  let outcome
  try {
    outcome = await runTransaction(db, async (tx) => {
      const claimSnap = await tx.get(claimRef)
      const liveClaim = claimSnap.exists() ? { id: claimSnap.id, ...claimSnap.data() } : null
      const invSnap = await tx.get(invoiceRef)
      const liveInvoice = invSnap.exists() ? { id: invSnap.id, ...invSnap.data() } : null
      if (!liveClaim) return fail(SI_WRITE_ERROR.MISSING, 'This progress claim no longer exists.')
      if (!liveInvoice) return fail(SI_WRITE_ERROR.MISSING, 'The supplier invoice no longer exists.')
      // A claim linked meanwhile is ALREADY_INVOICED (the link also moved its
      // revision, so this is checked before the stale test names it as a
      // mere change); any other disagreement on the server copies is INVALID.
      const error = existingInvoiceLinkError(liveClaim, liveInvoice)
      if (error) return fail(claimInvoiceLink(liveClaim).state === CLAIM_INVOICE_LINK.LINKED ? SI_WRITE_ERROR.ALREADY_INVOICED : SI_WRITE_ERROR.INVALID, error, { linkedInvoiceId: claimInvoiceLink(liveClaim).invoiceId })
      if (storedRevision(liveClaim) !== storedRevision(seenClaim)) {
        return fail(SI_WRITE_ERROR.STALE, `${liveClaim.claimNumber || 'This progress claim'} was changed by another user since you loaded it. Review the latest version and retry.`)
      }
      tx.update(claimRef, claimLinkUpdate(liveClaim, { invoiceId: invoiceRef.id, uid, now: serverTimestamp() }))
      return { kind: null, invoiceId: invoiceRef.id }
    })
  } catch (err) {
    if (err instanceof SupplierInvoiceWriteError) throw err
    throw new SupplierInvoiceWriteError(supplierInvoiceWriteErrorKind(err?.code), undefined, { cause: err })
  }
  if (outcome.kind) throw new SupplierInvoiceWriteError(outcome.kind, outcome.message, { linkedInvoiceId: outcome.linkedInvoiceId })
  return outcome
}
