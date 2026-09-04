import { roundMoney } from './purchaseOrders'
import { toCents, safeAmount, isIsoDateShape } from './payments'
import { SI_STATUS, SI_COUNTING_STATUSES, TAX_CODES, gstForLine, normaliseInvoiceRef } from './supplierInvoices'

// ── Supplier Credit Notes (accounts payable — reduction facts) ───────────────
//
// A Supplier Credit Note records a REDUCTION a supplier has issued against ONE
// posted Supplier Invoice: over-claimed quantities, rejected work, back-charges,
// or a negotiated reduction. It is the third document kind on the payable side,
// and each holds exactly one kind of truth (ADR-31):
//
//   · supplier invoice     — the original COST / PAYABLE fact
//   · supplier payment     — the CASH fact
//   · supplier credit note — the REDUCTION fact
//
// ⚠️ NOTHING HERE WRITES TO A SUPPLIER INVOICE. The posted invoice is never
// mutated, never stamped, and never given a credited-total field. Every net
// figure — Invoiced, Actual, Remaining Payable, AP ageing, Forecast Cash Out —
// is derived at read time from the three document kinds together (ADR-3/ADR-4).
// Voiding a credit note therefore restores every figure at the next render with
// no reversal document.
//
// ⚠️ A CREDIT NOTE IS NOT CASH. It moves no money: Actual Cash Out remains
// payment-only, and a credit never appears in any cash column. It reduces what
// is OWED (gross, via the target's payable balance) and what the project COST
// (ex-GST, via its cost-coded lines).
//
// ⚠️ RETAINED INVOICES CANNOT BE CREDITED in this foundation. A credit against
// an invoice that withheld retention is ambiguous — does the credit come out of
// the payable slice or the retained slice? The target must carry retentionTotal
// 0, enforced in the UI, here, AND by Firestore rules (which get() the target
// invoice — a first for the financial collections).
//
// ⚠️ THIS IS UNCHANGED BY RETENTION RELEASE (ADR-30). The gate reads the STORED,
// IMMUTABLE `retentionTotal`, never a release-aware figure, so an invoice whose
// retention has since been released — wholly or partly — remains uncreditable in
// V1. Releasing retention must never be a back door into crediting a retained
// invoice; the ambiguity above is unresolved either way.
//
// All canonical line amounts are ex-GST with per-line taxCode/gstAmount,
// exactly like the supplier-invoice lines they reverse. Every line REQUIRES a
// cost code (drawn from the target invoice's lines): a header-only credit
// would reduce AP cash but leave cost-code Actual/Invoiced — and therefore
// Forecast Final Cost and Margin — permanently overstated.

export const SCN_STATUS = {
  DRAFT:  'draft',
  POSTED: 'posted',
  VOID:   'void',
}

export const SCN_STATUS_LABELS = {
  [SCN_STATUS.DRAFT]:  'Draft',
  [SCN_STATUS.POSTED]: 'Posted',
  [SCN_STATUS.VOID]:   'Void',
}

// Maps each status onto an existing Badge variant — no new colours.
export const SCN_BADGE_VARIANTS = {
  [SCN_STATUS.DRAFT]:  'soon',
  [SCN_STATUS.POSTED]: 'active',
  [SCN_STATUS.VOID]:   'danger',
}

// Forward-only lifecycle, matching the cash collections: `posted` is the
// financial commit point; void is terminal (no un-post, no return to draft).
// Corrections are a void plus a new credit note, preserving the audit story
// (ADR-11/ADR-12). These transitions are ALSO enforced by Firestore rules
// (frontend/firestore.rules → supplierCreditNotes); this map stays the single
// client-side source of truth so the UI and the rules cannot drift.
export const SCN_TRANSITIONS = {
  [SCN_STATUS.DRAFT]:  [SCN_STATUS.POSTED, SCN_STATUS.VOID],
  [SCN_STATUS.POSTED]: [SCN_STATUS.VOID],
  [SCN_STATUS.VOID]:   [],
}

export const canTransition = (from, to) => (SCN_TRANSITIONS[from] ?? []).includes(to)

// The single counting point. A draft reduces nothing and a void credit reduces
// nothing, forever; only `posted` contributes to any derived figure — and even
// a posted credit contributes ONLY while its target is valid (see
// creditTargetException below).
export const SCN_COUNTING_STATUSES = [SCN_STATUS.POSTED]

// Content is editable only while draft. Posting freezes everything —
// rules-enforced. The TARGET (supplierInvoiceId and its frozen snapshots) is
// frozen from creation and can never change, even while draft: retargeting is
// a void plus a new credit note.
export const SCN_EDITABLE_STATUSES = [SCN_STATUS.DRAFT]

export const SCN_DOC_TYPE = {
  CREDIT_NOTE: 'credit_note',
}

export const SUPPLIER_CREDIT_NOTE_COUNTER_ID = 'supplierCreditNotes'

export const formatSupplierCreditNoteNumber = (n) => `SCN-${String(n).padStart(4, '0')}`

// Bounds the embedded line array (the ADR-6 trade-off). Mirrored in
// firestore.rules, which can check lineItems.size() but not the elements.
export const MAX_CREDIT_NOTE_LINES = 100

// ── Credit note sets ─────────────────────────────────────────────────────────

export const postedSupplierCreditNotes = (creditNotes) =>
  (creditNotes ?? []).filter(cn => SCN_COUNTING_STATUSES.includes(cn.status))

export const draftSupplierCreditNotes = (creditNotes) =>
  (creditNotes ?? []).filter(cn => cn.status === SCN_STATUS.DRAFT)

// ── Header totals (derived from line items) ──────────────────────────────────
//
// Same shape as a client invoice: subtotal (ex-GST) + gstTotal → grossTotal.
// A credit note carries NO retention and NO payable/gross split — its gross IS
// its payable effect, because retained invoices cannot be credited at all.
export function creditNoteTotals(lineItems) {
  const subtotal = roundMoney((lineItems ?? []).reduce((sum, li) => sum + (Number(li.amount) || 0), 0))
  const gstTotal = roundMoney((lineItems ?? []).reduce((sum, li) => sum + (Number(li.gstAmount) || 0), 0))
  return { subtotal, gstTotal, grossTotal: roundMoney(subtotal + gstTotal) }
}

// ── Eligible targets ─────────────────────────────────────────────────────────
//
// Only a POSTED supplier invoice with ZERO retention withheld (and a stored
// currency for the rules currency-match) can receive a credit note. `approved`
// is not the financial commit point; draft and cancelled invoices recognised no
// cost. Retained invoices are excluded in this foundation (see header).
// Mirrored by Firestore rules via a get() on the target invoice.
export const isCreditableInvoice = (inv) =>
  inv?.status === SI_STATUS.POSTED
  && toCents(safeAmount(inv.retentionTotal)) === 0
  && typeof inv.currency === 'string'
  && inv.currency.length > 0

export const creditableSupplierInvoices = (invoices) =>
  (invoices ?? []).filter(isCreditableInvoice)

export const RETAINED_INVOICE_BLOCK_TEXT =
  'Invoices with retention withheld cannot receive a credit note in this foundation — crediting a retained ' +
  'invoice is ambiguous: it is unclear whether the credit reduces the payable slice or the retained slice. ' +
  'This still applies once retention has been released. It is enforced by Firestore rules.'

// ── Supplier identity matching ───────────────────────────────────────────────
//
// Reproduces the module-private normaliseName in lib/supplierInvoices.js (the
// same note lib/supplierPayments.js carries) — keep the implementations
// identical if either is ever touched.
const normaliseName = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ')

// ── Read-time validity gate (THE safe-failure boundary) ──────────────────────
//
// THE SINGLE CENTRAL VALIDATION PATH. A POSTED credit note contributes to the
// derived figures ONLY when this returns null. Every consumer —
// creditedByInvoice, creditedByCostCode, creditNoteExceptions,
// creditNoteSummary, isCountingCreditNote — funnels through here, so a document
// that fails ANY check below contributes ZERO to every financial figure (both
// the payable side and the cost side) and is surfaced as an exception instead.
//
// ⚠️ THE SAFETY INVERSION THIS EXISTS FOR. Every earlier payable module failed
// safe by KEEPING cost visible; a forged or corrupted credit would ERASE cost
// and flatter margin — the dangerous direction. Firestore rules validate this
// document's SHAPE, its header cent invariant, and its target (via a get()),
// but they CANNOT iterate `lineItems`, so they cannot check that the stored
// headers match the lines, that per-line GST is right, or that each line's cost
// code belongs to the target invoice. Without the checks below, a rules-valid
// document could store `grossTotal: 100` while its lines claimed 50,000 —
// reducing AP by 100 and Actual by 50,000 at the same time, silently and
// unboundedly. Every one of those facts IS determinable at read time from data
// already loaded, so it is checked here.
//
// ⚠️ NEVER CLAMP. A failing document is excluded whole and reported; no figure
// is silently trimmed to a "safe" value, because a clamped forgery still lies.
//
// ⚠️ THIS IS AN ADDITIONAL GUARD, NOT A REPLACEMENT FOR RULES. It protects
// every figure Constrapp renders; it cannot protect data read by anything
// outside this app. The cumulative sibling cap and concurrency remain
// unenforceable anywhere on the client (docs/SECURITY.md → Deferred Control 25).
//
// The target status check uses SI_COUNTING_STATUSES (posted + the deprecated,
// forgeable `paid`), not posted alone: an invoice forged to `paid` still counts
// toward Invoiced/Actual over in lib/supplierInvoices.js, so its credit must
// keep counting too — dropping it would overstate cost, the wrong direction to
// fail, and the two derivations must never disagree about one invoice.
//
// Returns a distinct human-readable reason string, or null when the credit note
// is valid and may count.
export function creditTargetException(creditNote, invoiceById) {
  // ── Target relationship ────────────────────────────────────────────────────
  const inv = invoiceById?.get?.(creditNote?.supplierInvoiceId) ?? null
  if (!inv) {
    return 'The target supplier invoice no longer exists or is not readable.'
  }
  if (!SI_COUNTING_STATUSES.includes(inv.status)) {
    return `${inv.invoiceNumber} is ${inv.status} — a credit note only counts against a posted supplier invoice.`
  }
  const sameSupplier = inv.supplierId || creditNote.supplierId
    ? inv.supplierId === creditNote.supplierId
    : normaliseName(inv.supplierName) === normaliseName(creditNote.supplierName)
  if (!sameSupplier) {
    return `${inv.invoiceNumber} belongs to a different supplier (${inv.supplierName || 'unknown'}) than this credit note.`
  }
  if (inv.currency !== creditNote.currency) {
    return `${inv.invoiceNumber} is denominated in ${inv.currency || 'an unknown currency'}, not ${creditNote.currency || 'unknown'}.`
  }
  // Retention on the target is re-checked at READ TIME even though the rules
  // get() already validated it at create and at post. Since ADR-40 a posted
  // supplier invoice is rules-immutable, so retention can no longer be ADDED to
  // a target after the fact; this guard remains because it also catches an
  // invoice tampered with before ADR-40 and, more importantly, because rules
  // never verified the target's LINE data (Deferred Control 25) — the read-time
  // gate is what keeps a broken target out of every figure.
  if (toCents(safeAmount(inv.retentionTotal)) !== 0) {
    return `${inv.invoiceNumber} now withholds retention (${roundMoney(safeAmount(inv.retentionTotal)).toFixed(2)}) — a retained invoice cannot carry a credit note in this foundation.`
  }

  // ── Document integrity (what rules cannot see) ─────────────────────────────
  const lines = creditNote?.lineItems
  // A non-array would also crash the `for…of` in the derivations below.
  if (!Array.isArray(lines) || lines.length === 0) {
    return 'The credit note carries no readable line items, so its stored totals cannot be verified.'
  }
  const targetCostCodeIds = new Set(targetInvoiceCostCodes(inv).map(cc => cc.costCodeId))
  for (let i = 0; i < lines.length; i++) {
    const li = lines[i]
    const amount = Number(li?.amount)
    // Positive amounts are what make the header reconciliation below meaningful:
    // without this, offsetting +50,000 / −49,900 lines could reconcile to a
    // small header while wrecking two cost codes.
    if (!Number.isFinite(amount) || toCents(amount) <= 0) {
      return `Line ${i + 1} does not carry a positive ex-GST amount, so this credit note's totals cannot be trusted.`
    }
    if (!TAX_CODES.includes(li?.taxCode)) {
      return `Line ${i + 1} carries an unknown tax code, so its GST cannot be verified.`
    }
    if (toCents(safeAmount(li.gstAmount)) !== toCents(gstForLine(amount, li.taxCode))) {
      return `Line ${i + 1}'s stored GST does not match its ex-GST amount and tax code.`
    }
    if (!li.costCodeId || !targetCostCodeIds.has(li.costCodeId)) {
      return `Line ${i + 1} credits a cost code that is not on ${inv.invoiceNumber} — a credit may only reduce cost codes the invoice charged.`
    }
  }

  // Headers must reconcile to the lines, in whole cents. This is the check that
  // stops the two derivations trusting different numbers: the payable side reads
  // grossTotal, the cost side reads the lines, and they must agree.
  const totals = creditNoteTotals(lines)
  if (toCents(totals.subtotal) !== toCents(safeAmount(creditNote.subtotal))
    || toCents(totals.gstTotal) !== toCents(safeAmount(creditNote.gstTotal))
    || toCents(totals.grossTotal) !== toCents(safeAmount(creditNote.grossTotal))) {
    return `The stored totals (${roundMoney(safeAmount(creditNote.grossTotal)).toFixed(2)} gross) do not reconcile to the credit note's line items (${totals.grossTotal.toFixed(2)} gross).`
  }

  // Checked LAST, once grossTotal is known to reflect the lines — otherwise the
  // cap would be measured against an unverified number.
  if (toCents(safeAmount(creditNote.grossTotal)) > toCents(safeAmount(inv.payableTotal))) {
    return `The credit note gross (${roundMoney(safeAmount(creditNote.grossTotal)).toFixed(2)}) exceeds ${inv.invoiceNumber}'s payable total (${roundMoney(safeAmount(inv.payableTotal)).toFixed(2)}).`
  }
  return null
}

const invoicesById = (invoices) => new Map((invoices ?? []).map(inv => [inv.id, inv]))

export const isCountingCreditNote = (creditNote, invoiceById) =>
  SCN_COUNTING_STATUSES.includes(creditNote?.status)
  && creditTargetException(creditNote, invoiceById) === null

// ── Read-time derivations (never stored) ─────────────────────────────────────

// { supplierInvoiceId: Σ grossTotal } across POSTED, valid-target credit notes.
// Feeds Remaining Payable (payableTotal − paid − credited) in
// lib/supplierPayments.js, and through it AP ageing, the payment allocation
// picker, and Forecast Cash Out.
export function creditedByInvoice(creditNotes, invoices) {
  const byId = invoicesById(invoices)
  const map = {}
  for (const cn of postedSupplierCreditNotes(creditNotes)) {
    if (creditTargetException(cn, byId) !== null) continue
    map[cn.supplierInvoiceId] = roundMoney((map[cn.supplierInvoiceId] || 0) + safeAmount(cn.grossTotal))
  }
  return map
}

// { costCodeId: Σ ex-GST line amount } across POSTED, valid-target credit
// notes. Subtracted from Invoiced and Actual by cost code (never clamped —
// hiding an over-credited cost code would be the whole problem), and through
// Actual from Forecast Final Cost and Margin.
export function creditedByCostCode(creditNotes, invoices) {
  const byId = invoicesById(invoices)
  const map = {}
  for (const cn of postedSupplierCreditNotes(creditNotes)) {
    if (creditTargetException(cn, byId) !== null) continue
    for (const li of cn.lineItems ?? []) {
      if (!li.costCodeId) continue
      map[li.costCodeId] = roundMoney((map[li.costCodeId] || 0) + (Number(li.amount) || 0))
    }
  }
  return map
}

// ── Exceptions (invalid credits — surfaced, never auto-fixed) ────────────────
//
// A posted credit note that fails ANY check in creditTargetException — a broken
// target link OR a document-integrity failure rules cannot see — contributes
// NOTHING financially and is reported here instead: nothing is deleted,
// reassigned, clamped, or reversed automatically. Rules make a broken link hard
// to create (they get() the target at create, draft edit, and post) but cannot
// prevent the target being cancelled or altered AFTERWARDS — supplier-invoice
// lifecycle is still client-enforced (docs/SECURITY.md → Deferred Controls 1
// and 2) — and cannot inspect line items at all.
export function creditNoteExceptions(creditNotes, invoices) {
  const byId = invoicesById(invoices)
  const out = []
  for (const cn of postedSupplierCreditNotes(creditNotes)) {
    const reason = creditTargetException(cn, byId)
    if (!reason) continue
    out.push({
      creditNoteId:  cn.id,
      creditNumber:  cn.creditNumber,
      invoiceNumber: cn.invoiceNumber || '—',
      grossTotal:    roundMoney(safeAmount(cn.grossTotal)),
      reason,
    })
  }
  return out
}

export const CREDIT_EXCEPTION_REMEDY =
  'A credit note listed here failed a read-time integrity check — a broken target link, or stored totals that do ' +
  'not reconcile to its own line items. It contributes nothing to any figure, so project cost stays visible, ' +
  'which is the safe failure. Nothing is clamped or reversed automatically. Investigate first; where the credit ' +
  'note itself is wrong, void it and record a new one against the correct invoice.'

// ── Over-credit (HARD BLOCKED in the app; cumulative cap not rules-enforceable) ──
//
// The cumulative rule: posted credit gross against one invoice, plus the credit
// being saved/posted, must never exceed the target's payableTotal. Unlike the
// warn-and-acknowledge posture of over-payment and over-invoicing, this is a
// HARD BLOCK — a credit note asserts the supplier reduced a specific debt, and
// crediting more than the debt is not a judgement call the way over-paying
// cash can be.
//
// ⚠️ ENFORCEMENT IS SPLIT (docs/SECURITY.md → Deferred Control 25):
//   · Firestore rules enforce the SINGLE-DOCUMENT cap — one credit note's
//     grossTotal may never exceed the target invoice's payableTotal (a get()
//     on the target).
//   · The CUMULATIVE cap across sibling credit notes is enforced HERE ONLY —
//     rules have no list, query, or count, so no rule can sum sibling credit
//     notes, and two users can post credits against the same invoice
//     concurrently. Never describe the cumulative cap as rules-enforced.

// Σ grossTotal of posted credit notes targeting one invoice — the cumulative
// figure the cap is measured against. Deliberately IGNORES target validity:
// the cap is conservative, so a posted credit with a currently-broken link
// still consumes headroom rather than silently widening it.
export function postedCreditedGrossForInvoice(creditNotes, supplierInvoiceId, { excludeCreditNoteId = null } = {}) {
  let total = 0
  for (const cn of postedSupplierCreditNotes(creditNotes)) {
    if (cn.id === excludeCreditNoteId) continue
    if (cn.supplierInvoiceId !== supplierInvoiceId) continue
    total = roundMoney(total + safeAmount(cn.grossTotal))
  }
  return total
}

// Returns a blocking error message, or null when the credit fits. Compared in
// whole cents (lib/payments.js → toCents) so a cent-exact full credit passes.
export function overCreditError({ invoice, proposedGross, creditNotes, excludeCreditNoteId = null }) {
  if (!invoice) return null
  const cap     = roundMoney(safeAmount(invoice.payableTotal))
  const already = postedCreditedGrossForInvoice(creditNotes, invoice.id, { excludeCreditNoteId })
  const after   = roundMoney(already + roundMoney(safeAmount(proposedGross)))
  if (toCents(after) <= toCents(cap)) return null
  const excess = roundMoney(after - cap)
  return `This credit note would take total posted credits against ${invoice.invoiceNumber} to ` +
    `${after.toFixed(2)} (gross), exceeding its payable total of ${cap.toFixed(2)} by ${excess.toFixed(2)}. ` +
    'Reduce the credit amount — an invoice cannot be credited beyond what it made payable.'
}

// ── Target cost codes ────────────────────────────────────────────────────────
//
// The cost codes a credit line may use: exactly those on the target invoice's
// lines (frozen name from the invoice snapshot). Crediting a cost code the
// invoice never charged would move cost between codes, which is a correction
// this foundation does not model.
export function targetInvoiceCostCodes(invoice) {
  const seen = new Map()
  for (const li of invoice?.lineItems ?? []) {
    if (!li.costCodeId) continue
    if (!seen.has(li.costCodeId)) seen.set(li.costCodeId, li.costCodeName || '')
  }
  return [...seen.entries()].map(([costCodeId, costCodeName]) => ({ costCodeId, costCodeName }))
}

// ── Display helpers ──────────────────────────────────────────────────────────

// Credit notes raised against one invoice (any status — callers filter/badge),
// newest number first for the invoice detail table.
export function creditNotesForInvoice(creditNotes, supplierInvoiceId) {
  return (creditNotes ?? [])
    .filter(cn => cn.supplierInvoiceId === supplierInvoiceId)
    .sort((a, b) => (b.creditNumber || '').localeCompare(a.creditNumber || ''))
}

// Register-level summary. `postedGross` counts ONLY valid-target posted credits
// (what the figures actually subtract); broken-target credits are counted
// separately so the two never blur.
export function creditNoteSummary(creditNotes, invoices) {
  const byId = invoicesById(invoices)
  const posted = postedSupplierCreditNotes(creditNotes)
  const drafts = draftSupplierCreditNotes(creditNotes)

  let postedGross = 0
  let exceptionGross = 0
  let exceptionCount = 0
  for (const cn of posted) {
    if (creditTargetException(cn, byId) === null) {
      postedGross = roundMoney(postedGross + safeAmount(cn.grossTotal))
    } else {
      exceptionGross = roundMoney(exceptionGross + safeAmount(cn.grossTotal))
      exceptionCount += 1
    }
  }

  let draftGross = 0
  for (const cn of drafts) draftGross = roundMoney(draftGross + safeAmount(cn.grossTotal))

  return {
    postedCount: posted.length - exceptionCount,
    postedGross,
    exceptionCount,
    exceptionGross,
    draftCount: drafts.length,
    draftGross,
  }
}

// ── Duplicate detection (warning-only, client-enforced) ──────────────────────
//
// Warns when the supplier's own credit reference already exists for the same
// supplier — the duplicateInvoiceWarnings idiom. Keys on supplierId when
// present, falling back to the frozen supplierName for legacy (supplierId:
// null) documents. Void credit notes are ignored. Never blocks — server-side
// uniqueness is deferred (Deferred Control 9's class).
export function duplicateCreditWarnings(creditNotes, { id = null, supplierId = null, supplierName = '', supplierCreditReference = '' }) {
  const ref = normaliseInvoiceRef(supplierCreditReference)
  if (!ref) return []
  const name = normaliseName(supplierName)
  const warnings = []
  for (const cn of creditNotes ?? []) {
    if (id && cn.id === id) continue
    if (cn.status === SCN_STATUS.VOID) continue
    if (normaliseInvoiceRef(cn.supplierCreditReference) !== ref) continue
    const sameSupplier = supplierId
      ? cn.supplierId === supplierId
      : (!cn.supplierId && normaliseName(cn.supplierName) === name)
    if (sameSupplier) {
      warnings.push({
        field: 'supplierCreditReference',
        message: `Credit reference ${cn.supplierCreditReference} already recorded for this supplier (${cn.creditNumber}).`,
      })
    }
  }
  return warnings
}

// ── Validation (client-enforced business checks + the rules-mirrored shape) ──
//
// Returns an error message, or null when the draft is saveable.
//
// ⚠️ Firestore rules enforce the document's SHAPE, lifecycle, the header cent
// invariant, and the SINGLE-DOCUMENT target checks (target exists, is posted,
// zero retention, same supplier and currency, grossTotal ≤ payableTotal — via
// a get() on the target). The per-line checks and the CUMULATIVE cap below are
// client-side and bypassable by a direct SDK call (Deferred Control 25). Never
// describe those as enforced.
export function validateCreditNoteDraft(
  { supplierInvoiceId, creditDate, reason, lineItems },
  { invoice = null, creditNotes = null, excludeCreditNoteId = null } = {},
) {
  if (!supplierInvoiceId) return 'Select the posted supplier invoice this credit note adjusts.'
  if (invoice && invoice.id !== supplierInvoiceId) {
    return 'The supplied invoice does not match the selected target.'
  }
  if (invoice && !isCreditableInvoice(invoice)) {
    if (invoice.status !== SI_STATUS.POSTED) {
      return `${invoice.invoiceNumber} is ${invoice.status} — only posted supplier invoices can be credited.`
    }
    if (toCents(safeAmount(invoice.retentionTotal)) !== 0) {
      return `${invoice.invoiceNumber} withheld retention. ${RETAINED_INVOICE_BLOCK_TEXT}`
    }
    return `${invoice.invoiceNumber} has no stored currency, so the rules currency match cannot pass — it cannot be credited.`
  }
  if (!isIsoDateShape(creditDate)) return 'Enter the credit note date.'
  if (!String(reason || '').trim()) return 'Enter the reason this credit was issued.'

  const lines = lineItems ?? []
  if (lines.length === 0) return 'Add at least one line with an amount.'
  if (lines.length > MAX_CREDIT_NOTE_LINES) {
    return `A credit note cannot carry more than ${MAX_CREDIT_NOTE_LINES} lines.`
  }

  const allowedCostCodes = invoice
    ? new Set(targetInvoiceCostCodes(invoice).map(cc => cc.costCodeId))
    : null
  for (let i = 0; i < lines.length; i++) {
    const li = lines[i]
    if (!String(li.description || '').trim()) return `Line ${i + 1}: enter a description.`
    const amount = Number(li.amount)
    if (!Number.isFinite(amount)) return `Line ${i + 1}: amount must be a number.`
    if (amount <= 0) return `Line ${i + 1}: amount must be greater than zero — the credit note itself is the reduction.`
    if (!TAX_CODES.includes(li.taxCode)) return `Line ${i + 1}: choose a tax code.`
    if (!li.costCodeId) return `Line ${i + 1}: choose the cost code this credit reduces.`
    if (!String(li.costCodeName || '').trim()) return `Line ${i + 1}: the chosen cost code has no display name.`
    if (allowedCostCodes && !allowedCostCodes.has(li.costCodeId)) {
      return `Line ${i + 1}: ${li.costCodeName || 'that cost code'} is not on ${invoice.invoiceNumber} — a credit may only reduce cost codes the invoice charged.`
    }
  }

  if (invoice) {
    const totals = creditNoteTotals(lines)
    // Single-document cap (rules-mirrored), then the cumulative HARD BLOCK.
    if (toCents(totals.grossTotal) > toCents(safeAmount(invoice.payableTotal))) {
      return `The credit note gross (${totals.grossTotal.toFixed(2)}) exceeds ${invoice.invoiceNumber}'s payable total ` +
        `(${roundMoney(safeAmount(invoice.payableTotal)).toFixed(2)}). An invoice cannot be credited beyond what it made payable.`
    }
    if (creditNotes) {
      const overError = overCreditError({
        invoice, proposedGross: totals.grossTotal, creditNotes, excludeCreditNoteId,
      })
      if (overError) return overError
    }
  }
  return null
}

// Why a draft cannot be posted yet, or null when it can. Posting re-runs the
// target and cumulative checks against CURRENT data: the invoice may have been
// cancelled, or a sibling credit posted, since the draft was saved.
export function postBlockedReason(creditNote, invoices, creditNotes) {
  if (!creditNote) return 'Credit note not found.'
  if (creditNote.status !== SCN_STATUS.DRAFT) {
    return `Only a draft credit note can be posted — this one is ${creditNote.status}.`
  }
  const inv = (invoices ?? []).find(i => i.id === creditNote.supplierInvoiceId) ?? null
  if (!inv) return 'The target supplier invoice could not be found on this project.'
  if (!isCreditableInvoice(inv)) {
    return inv.status !== SI_STATUS.POSTED
      ? `${inv.invoiceNumber} is ${inv.status} — only posted supplier invoices can be credited.`
      : `${inv.invoiceNumber} cannot be credited. ${RETAINED_INVOICE_BLOCK_TEXT}`
  }
  const overError = overCreditError({
    invoice: inv,
    proposedGross: creditNote.grossTotal,
    creditNotes,
    excludeCreditNoteId: creditNote.id,
  })
  if (overError) return overError
  return null
}

// Builds the stored line array from editor rows, dropping empty rows — the
// buildAllocations idiom. `costCodes` are the target invoice's
// targetInvoiceCostCodes(), used to freeze the display name.
export function buildCreditNoteLineItems(rows, costCodes) {
  const nameById = new Map((costCodes ?? []).map(cc => [cc.costCodeId, cc.costCodeName]))
  return (rows ?? [])
    .filter(r => r.costCodeId && Number(r.amount) > 0)
    .map(r => ({
      costCodeId:   r.costCodeId,
      costCodeName: nameById.get(r.costCodeId) ?? r.costCodeName ?? '',
      description:  String(r.description || '').trim(),
      amount:       roundMoney(Number(r.amount)),
      taxCode:      r.taxCode,
      gstAmount:    roundMoney(Number(r.gstAmount) || 0),
    }))
}

// ⚠️ A FAILED CREDIT-NOTE READ IS UNKNOWN, NEVER ZERO. Posted credit notes
// REDUCE Invoiced, Actual and each invoice's remaining payable. Treating an
// unreadable list as empty would silently misstate every one of those figures,
// so each consuming page surfaces this instead of rendering as though no
// credits exist. On the cost side the error direction is conservative (cost
// stays overstated, margin understated), which is why these pages warn rather
// than blanking every figure; the payable side is the dangerous direction and
// is handled by disabling actions and rendering balances unavailable.
export const CREDIT_READ_ERROR_NOTICE =
  'Supplier Credit Notes could not be loaded. Posted credit notes reduce Invoiced and Actual by cost code, so ' +
  'the cost and margin figures below may be OVERSTATED by any credits that exist. They are not shown as though ' +
  'no credits exist — reload the page, and check your connection and permissions if this persists.'

// Still honest about what is NOT enforced.
export const CREDIT_NOTE_NOTICE =
  'Each credit note is capped at its target invoice\'s payable total by Firestore rules, but the CUMULATIVE cap ' +
  'across several credit notes is app-enforced only — rules cannot sum sibling documents, so two users can post ' +
  'credits against the same invoice concurrently. Credits against retained invoices are blocked. A posted credit ' +
  'that fails a read-time integrity check — a broken target link, or stored totals that do not reconcile to its ' +
  'own line items — counts nothing and is listed as an exception rather than being clamped.'
