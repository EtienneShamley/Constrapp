import { PO_STATUS, GST_RATE, roundMoney } from './purchaseOrders'

// ── Supplier Invoices (accounts payable) ─────────────────────────────────────
// Supplier invoices are the cost-side "bills" a company receives from its
// suppliers/subcontractors. They are distinct from future client/accounts-
// receivable invoices — the general word "invoices" is reserved for those.
//
// All canonical line amounts are ex-GST; GST is stored per line as gstAmount.
// Financial figures are always derived at read time (like POs/claims) — invoice
// code never writes onto Budget Line documents.

export const SI_STATUS = {
  DRAFT:        'draft',
  RECEIVED:     'received',      // reserved — no UI transition yet
  UNDER_REVIEW: 'under_review',  // reserved — no UI transition yet
  APPROVED:     'approved',
  DISPUTED:     'disputed',      // reserved — no UI transition yet
  POSTED:       'posted',
  // ⚠️ DEPRECATED IN PLACE — NOT reserved, and never to be activated (ADR-24).
  // Supplier Payments shipped and deliberately did NOT turn this on: payment
  // state is DERIVED from posted Supplier Payment allocations
  // (lib/supplierPayments.js), so authoring a `paid` status would create a
  // second, contradictory source of payment truth with no way to reconcile the
  // two. No supported application path writes this value, and SI_TRANSITIONS
  // (below) contains no transition into it.
  //
  // It is retained — with its label and badge variant — so that a legacy or
  // malformed document can still render.
  //
  // ⚠️ ADR-40 CLOSED THE FORGERY PATH, BUT NOT RETROSPECTIVELY. Firestore Rules
  // now permit exactly draft → approved → posted plus cancellation, so NO caller
  // can author `status: 'paid'` on a new or existing invoice from here on. What
  // rules cannot do is revert PAST tampering: any document that already holds
  // this value keeps it, which is exactly why the value, its label, and its
  // place in SI_COUNTING_STATUSES all stay.
  PAID:         'paid',
  CANCELLED:    'cancelled',
}

export const SI_STATUS_LABELS = {
  [SI_STATUS.DRAFT]:        'Draft',
  [SI_STATUS.RECEIVED]:     'Received',
  [SI_STATUS.UNDER_REVIEW]: 'Under Review',
  [SI_STATUS.APPROVED]:     'Approved',
  [SI_STATUS.DISPUTED]:     'Disputed',
  [SI_STATUS.POSTED]:       'Posted',
  [SI_STATUS.PAID]:         'Paid',
  [SI_STATUS.CANCELLED]:    'Cancelled',
}

// Maps each status onto an existing Badge variant — no new colours.
export const SI_BADGE_VARIANTS = {
  [SI_STATUS.DRAFT]:        'soon',
  [SI_STATUS.RECEIVED]:     'info',
  [SI_STATUS.UNDER_REVIEW]: 'pending',
  [SI_STATUS.APPROVED]:     'info',
  [SI_STATUS.DISPUTED]:     'danger',
  [SI_STATUS.POSTED]:       'active',
  [SI_STATUS.PAID]:         'completed',
  [SI_STATUS.CANCELLED]:    'danger',
}

// Forward-only lifecycle. received/under_review/disputed are reserved (defined
// but no UI transitions into them). `paid` is DEPRECATED IN PLACE, not reserved:
// there is no transition into it and there never will be (ADR-24).
// posted is terminal in this foundation — corrections are Credit Notes (future).
export const SI_TRANSITIONS = {
  [SI_STATUS.DRAFT]:        [SI_STATUS.APPROVED, SI_STATUS.CANCELLED],
  [SI_STATUS.RECEIVED]:     [],
  [SI_STATUS.UNDER_REVIEW]: [],
  [SI_STATUS.APPROVED]:     [SI_STATUS.POSTED, SI_STATUS.CANCELLED],
  [SI_STATUS.DISPUTED]:     [],
  // TERMINAL. There is deliberately NO posted -> paid transition and there never
  // will be — payment state is derived from Supplier Payment allocations, never
  // authored onto the invoice (ADR-24).
  [SI_STATUS.POSTED]:       [],
  [SI_STATUS.PAID]:         [],
  [SI_STATUS.CANCELLED]:    [],
}

export const canTransition = (from, to) => (SI_TRANSITIONS[from] ?? []).includes(to)

// Statuses whose value counts toward the budget figures.
//
// `paid` is INERT: no supported application path writes it and SI_TRANSITIONS
// reaches it from nowhere, so the app never produces such a document. Since
// ADR-40 no DIRECT-SDK path produces one either — Firestore Rules make the
// status unauthorable. It is nevertheless deliberately RETAINED in this list
// rather than removed, because rules prevent FUTURE tampering and do not revert
// PAST tampering: if a document forged before ADR-40 still holds `paid`,
// dropping it here would silently erase that invoice from Invoiced and Actual.
// Counting it is the safe failure mode — the cost stays visible in the budget
// figures. Removing it is a data-migration decision, not a code decision.
//
// It is NOT used for payment reconciliation. Paid to Date and Remaining Payable
// derive exclusively from posted Supplier Payment allocations
// (lib/supplierPayments.js), which counts only `posted` invoices (ADR-24).
export const SI_COUNTING_STATUSES = [SI_STATUS.POSTED, SI_STATUS.PAID]

// Statuses whose authored content (references, dates, notes, and — for a
// `direct_po` invoice — line amounts, tax codes and retention) may still change.
// Exactly draft: `approved` is the AUTHORING FREEZE POINT and every later status
// is frozen too. `posted` is a separate, later thing — the FINANCIAL COUNTING
// POINT (SI_COUNTING_STATUSES). RULES-ENFORCED since ADR-40: Firestore rules
// permit a content edit only while the stored status is `draft`, and an approved
// or posted invoice matches no editing branch at all. The client hook and editor
// mirror it for a friendly message, not as the control.
export const SI_EDITABLE_STATUSES = [SI_STATUS.DRAFT]

// Whether an invoice may still be corrected in place. Content-only — it says
// nothing about lifecycle actions, which stay with canTransition.
export const isEditableInvoice = (inv) => SI_EDITABLE_STATUSES.includes(inv?.status)

export const SI_SOURCE = {
  PROGRESS_CLAIM: 'progress_claim',
  DIRECT_PO:      'direct_po',
}

export const SI_DOC_TYPE = {
  INVOICE:     'invoice',
  CREDIT_NOTE: 'credit_note', // reserved — Credit Notes are a future module
}

// Only sent/closed POs can be invoiced (draft/cancelled POs are not commitments).
export const INVOICEABLE_PO_STATUSES = [PO_STATUS.SENT, PO_STATUS.CLOSED]

// ── Tax codes ────────────────────────────────────────────────────────────────
// Per-line tax treatment lets one invoice mix taxable, GST-free, and input-taxed
// lines. Only `gst` attracts GST; the others are zero-rated. GST-inclusive entry
// is a UI concern — storage is always ex-GST plus gstAmount per line.
export const TAX_CODE = {
  GST:         'gst',
  GST_FREE:    'gst_free',
  INPUT_TAXED: 'input_taxed',
}

export const TAX_CODES = Object.values(TAX_CODE)

export const TAX_CODE_LABELS = {
  [TAX_CODE.GST]:         'GST 10%',
  [TAX_CODE.GST_FREE]:    'GST-free',
  [TAX_CODE.INPUT_TAXED]: 'Input-taxed',
}

// GST for one line: 10% of the ex-GST amount for `gst`, otherwise zero.
export function gstForLine(amount, taxCode) {
  const amt = Number(amount) || 0
  return taxCode === TAX_CODE.GST ? roundMoney(amt * GST_RATE) : 0
}

export const formatSupplierInvoiceNumber = (n) => `SI-${String(n).padStart(4, '0')}`

// Header totals from ex-GST line amounts and per-line GST.
//
// Gross invoice values describe the full taxable supply:
//   subtotal   = Σ line amount (ex-GST, gross certified)
//   gstTotal   = Σ line gstAmount (GST on the gross lines)
//   grossTotal = subtotal + gstTotal
//
// Retention is a header-level ex-GST withholding. It carries its own GST so the
// payable figures reconcile to a Progress Claim, whose GST is computed on the
// net (post-retention) amount. Retention GST is 10% of the retained amount
// (Progress Claims use flat 10%); direct invoices use retention 0, so all
// retention figures fall to 0.
//   retention      = retained ex-GST (clamped to subtotal)
//   retentionGst   = retained × 10%
//   retentionTotal = retention + retentionGst
//
// Payable values are what is actually due this invoice — never the full
// tax-invoice value:
//   net          = subtotal − retention
//   payableGst   = gstTotal − retentionGst   (equals a claim's approvedGst)
//   payableTotal = grossTotal − retentionTotal (equals a claim's approvedTotal)
export function invoiceTotals(lineItems, retention = 0) {
  const subtotal   = roundMoney((lineItems ?? []).reduce((sum, li) => sum + (Number(li.amount) || 0), 0))
  const gstTotal   = roundMoney((lineItems ?? []).reduce((sum, li) => sum + (Number(li.gstAmount) || 0), 0))
  const grossTotal = roundMoney(subtotal + gstTotal)
  const retained       = Math.min(roundMoney(Number(retention) || 0), subtotal)
  const retentionGst   = roundMoney(retained * GST_RATE)
  const retentionTotal = roundMoney(retained + retentionGst)
  const net          = roundMoney(subtotal - retained)
  const payableGst   = roundMoney(gstTotal - retentionGst)
  const payableTotal = roundMoney(grossTotal - retentionTotal)
  return { subtotal, gstTotal, grossTotal, retention: retained, retentionGst, retentionTotal, net, payableGst, payableTotal }
}

// Reconciliation guard for the progress_claim path: a claim-sourced invoice must
// pay exactly the approved claim's certified GST and total. Returns null when it
// reconciles, otherwise a clear message (used to block creation). `approvedGst`
// and `approvedTotal` come from the approved claim (which uses flat 10% GST on
// the net); `payableGst`/`payableTotal` are this invoice's post-retention figures.
export function claimReconciliationError(totals, { approvedGst, approvedTotal } = {}) {
  if (approvedGst == null || approvedTotal == null) {
    return 'The approved claim is missing certified totals — cannot reconcile the invoice.'
  }
  if (roundMoney(totals.payableGst) !== roundMoney(approvedGst)) {
    return `Invoice payable GST (${roundMoney(totals.payableGst)}) does not reconcile to the approved claim GST (${roundMoney(approvedGst)}).`
  }
  if (roundMoney(totals.payableTotal) !== roundMoney(approvedTotal)) {
    return `Invoice payable total (${roundMoney(totals.payableTotal)}) does not reconcile to the approved claim total (${roundMoney(approvedTotal)}).`
  }
  return null
}

// ── Duplicate detection (warning-only, client-enforced) ──────────────────────

// Normalise a supplier invoice reference for comparison: trim, lower-case, strip
// all whitespace so "INV 123" and "inv123" collide.
export const normaliseInvoiceRef = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, '')
const normaliseName = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ')

// Warns when the same supplier invoice number already exists for the supplier.
// Keys on supplierId when present; falls back to the supplier name snapshot for
// pre-Contacts (supplierId: null) documents. Cancelled invoices are ignored.
// Never blocks — server-enforced uniqueness is deferred.
export function duplicateInvoiceWarnings(invoices, { id = null, supplierId = null, supplierName = '', supplierInvoiceNumber = '' }) {
  const ref = normaliseInvoiceRef(supplierInvoiceNumber)
  if (!ref) return []
  const name = normaliseName(supplierName)
  const warnings = []
  for (const inv of invoices) {
    if (id && inv.id === id) continue
    if (inv.status === SI_STATUS.CANCELLED) continue
    if (normaliseInvoiceRef(inv.supplierInvoiceNumber) !== ref) continue
    const sameSupplier = supplierId
      ? inv.supplierId === supplierId
      : (!inv.supplierId && normaliseName(inv.supplierName) === name)
    if (sameSupplier) {
      warnings.push({ field: 'supplierInvoiceNumber', message: `Invoice ${inv.supplierInvoiceNumber} already recorded for this supplier (${inv.invoiceNumber}).` })
    }
  }
  return warnings
}

// One approved claim may carry only one non-cancelled supplier invoice.
export const claimHasActiveInvoice = (invoices, progressClaimId) =>
  !!progressClaimId && invoices.some(inv => inv.progressClaimId === progressClaimId && inv.status !== SI_STATUS.CANCELLED)

// ── Draft editing (ADR-38) ───────────────────────────────────────────────────
//
// A DRAFT supplier invoice may be corrected in place instead of being cancelled
// and re-raised (which burns an SI-#### number). These helpers are shared by the
// editor and the update hook so the two cannot drift, and they encode the two
// structural guarantees the feature rests on.
//
// 1. THE STORED LINE SET IS FIXED. An invoice carries the lines that were
//    actually stored when the draft was raised — for `direct_po` that is the
//    PO lines that had a non-zero amount, because create filters the rest out.
//    Edit offers no add, remove, reorder or reseed control and the update
//    contract has no channel for one: `poLineIndex` is the identity
//    postedInvoicedByPoLine keys off to mature Committed, so an invented,
//    dropped or shifted line would silently repoint invoiced-to-date onto the
//    wrong PO line. A PO line never priced at create is therefore unreachable
//    by editing — cancel the draft and raise a new invoice. A line that IS
//    stored may be taken to zero and back, because its identity stays stored.
//
// 2. IDENTITY COMES FROM THE STORED LINE, NEVER FROM FORM STATE. buildInvoiceLine
//    reads poLineIndex/costCodeId/costCodeName/description from its `source`
//    argument, which in edit mode IS the stored line — so a draft edit cannot
//    repoint a line at a different PO line or cost code, and `gstAmount` is
//    always re-derived rather than believed.
//
// ⚠️ WHAT IS AND IS NOT ENFORCED HERE (updated by ADR-40). Firestore rules on
// this collection now enforce draft-only editing, the approved authoring freeze,
// posted/cancelled immutability, the immutable identity set, the scalar header
// arithmetic, and — for a `progress_claim` invoice — that a draft edit touches
// the header and NOTHING financial. What they still cannot enforce is
// guarantee 2 above and everything else inside the array: rules can neither
// iterate nor index `lineItems`, so per-line identity, amounts, tax codes and
// gstAmount stay CLIENT-ENFORCED ONLY. Rules bound the line COUNT (guarantee 1)
// and the header totals; the identity discipline below is what makes the
// contents correct (docs/SECURITY.md → Deferred Control 29).

// Whether this invoice was raised from an approved progress claim. Claim-sourced
// drafts are HEADER-ONLY editable: their line amounts, tax codes and retention
// are the certified claim values and must keep reconciling to them, so the
// editor renders them read-only and the update contract ignores any attempt to
// supply them (ADR-38 D1).
export const isClaimSourced = (inv) => inv?.source === SI_SOURCE.PROGRESS_CLAIM

// Stored invoice line -> the editor's per-line form values.
//
// `amount` becomes a string, matching the create seed, and a missing, empty or
// malformed legacy value reads as '0' — never '', which would render an empty
// input the user could mistake for "nothing invoiced on this line".
//
// `taxCode` is passed through VERBATIM and is deliberately NOT defaulted to
// `gst` (ADR-38 D7). An unrecognised or missing legacy code must stay visible as
// invalid so the user is required to choose one, rather than being silently
// rewritten to a taxable code — which would change GST, the header totals and,
// once posted, Actual. `invalidTaxCode` says exactly that, so the editor can
// render the correction prompt without re-deriving the rule.
export function invoiceLineToForm(line) {
  const li  = line && typeof line === 'object' ? line : {}
  const raw = li.amount
  const n   = Number(raw)
  const amount = (raw === '' || raw == null || !Number.isFinite(n)) ? '0' : String(n)
  const taxCode = typeof li.taxCode === 'string' ? li.taxCode : ''
  return { amount, taxCode, invalidTaxCode: !TAX_CODES.includes(taxCode) }
}

// ONE builder for both modes, so CREATE and EDIT DRAFT cannot drift.
//
// `source` supplies the line's IDENTITY and is never authored by the user:
//   · CREATE — the PO line (index supplied by the caller as `poLineIndex`) or
//     the approved claim line (which already carries `poLineIndex`).
//   · EDIT   — the STORED invoice line, which already carries all four identity
//     fields, so the caller supplies nothing but the authored money.
//
// `gstAmount` is ALWAYS re-derived through gstForLine; a caller-supplied value is
// never trusted. `taxCode` is stored exactly as given — validation rejects an
// invalid code before any write, rather than this builder quietly repairing one.
//
// ⚠️ `gstFromUnroundedAmount` EXISTS SOLELY TO PRESERVE PRE-ADR-38 CREATE
// BEHAVIOUR, BYTE FOR BYTE. The create modal has always derived the two money
// fields from the entered figure in this order:
//
//     amount:    roundMoney(entered)     // rounded to cents
//     gstAmount: gstForLine(entered)     // from the UNROUNDED figure
//
// For an entry with more than two decimals the two bases can differ by one cent
// (e.g. 1234.045 -> amount 1234.05, with GST 123.40 raw vs 123.41 rounded), so
// collapsing them would silently change what CREATE stores. ADR-38 was required
// to leave create untouched, so create passes this flag and gets exactly its old
// arithmetic; the claim path is unaffected either way because it already hands in
// a rounded `approvedThisPeriod`.
//
// EDIT DRAFT does NOT pass it and must not: rebuilding from the ROUNDED stored
// amount is what makes every edited line satisfy
// `gstAmount === gstForLine(amount, taxCode)`, the self-consistency invariant
// claimSourcedDriftError relies on. The flag changes only which figure the GST is
// computed from — it never affects identity, the stored `amount`, or the refusal
// to trust a caller-supplied `gstAmount`.
export function buildInvoiceLine(source, { amount, taxCode, poLineIndex, gstFromUnroundedAmount = false } = {}) {
  const src = source && typeof source === 'object' ? source : {}
  const str = (v) => (typeof v === 'string' ? v : '')
  const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0 }

  const idx = poLineIndex ?? src.poLineIndex
  const raw = num(amount)
  const amt = roundMoney(raw)
  const tc  = typeof taxCode === 'string' ? taxCode : ''

  return {
    poLineIndex:  num(idx),
    costCodeId:   str(src.costCodeId),
    costCodeName: str(src.costCodeName),
    description:  str(src.description),
    amount:       amt,
    taxCode:      tc,
    gstAmount:    gstForLine(gstFromUnroundedAmount ? raw : amt, tc),
  }
}

// Positional-pairing guard for the `direct_po` draft-edit contract: the caller
// supplies one amount and one tax code per STORED line, in stored order. A length
// mismatch would silently pair authored values with the wrong lines, so it is
// refused outright rather than padded or truncated. Returns null when exact.
//
// Not used on the claim-sourced path, which authors no line values at all.
export function invoiceLineInputCountError(lineItems, amounts, taxCodes) {
  if (!Array.isArray(lineItems) || lineItems.length === 0) {
    return 'This supplier invoice has no line items to edit'
  }
  const n = lineItems.length
  if (!Array.isArray(amounts) || amounts.length !== n) {
    const got = Array.isArray(amounts) ? amounts.length : 0
    return `An amount is required for every invoice line (expected ${n}, got ${got})`
  }
  if (!Array.isArray(taxCodes) || taxCodes.length !== n) {
    const got = Array.isArray(taxCodes) ? taxCodes.length : 0
    return `A tax code is required for every invoice line (expected ${n}, got ${got})`
  }
  return null
}

// THE RETENTION FLOOR — shared by CREATE (the hook) and EDIT
// (validateInvoiceDraft below), so the two cannot drift.
//
// `invoiceTotals` deliberately clamps only the UPPER bound (a retention above
// the subtotal falls to the subtotal). It applies NO floor, so a negative
// retention flows straight through into the stored document and makes `net`
// exceed `subtotal` and `payableTotal` exceed `grossTotal` — the invoice would
// claim more payable than the supply is worth.
//
// ADR-38 D6 put this floor on the EDIT path only, leaving CREATE guarded by
// nothing but the editor input's `min="0"` attribute — which is browser
// constraint validation, not a control. ADR-40 closes that asymmetry by calling
// this from `createSupplierInvoice` before any total is derived, and mirrors it
// in Firestore Rules (`retention >= 0`, whole cents), so the floor now holds at
// the domain boundary AND at the trust boundary.
//
// Deliberately narrow: it validates the retention SCALAR and nothing else.
// Create's other validity checks are unchanged (ADR-38: preserve create
// behaviour exactly).
export function retentionFloorError(retention) {
  const retained = Number(retention)
  if (!Number.isFinite(retained)) return 'Retention must be a number'
  if (retained < 0) return 'Retention cannot be negative'
  return null
}

// Draft content validation for EDIT. Returns null when valid, else the first
// error.
//
//   · a supplier invoice reference is required (create's `refValid`);
//   · an invoice date is required (create's `dateValid`);
//   · at least one line must carry a positive amount (create's `hasAmount`,
//     which create achieves by filtering zero lines out before saving);
//
// The next two clauses apply only when the line values are AUTHORED, i.e. the
// `direct_po` path (`authoredLines`, default true). A claim-sourced draft
// authors neither — its amounts, tax codes and retention are the certified claim
// values, preserved byte-for-byte — so refusing to save a HEADER correction over
// odd legacy line data there would block a fix the user cannot otherwise make.
// That path is guarded by claimSourcedDriftError instead.
//
//   · every line's tax code must be one of TAX_CODES — ADR-38 D7, so a legacy
//     invoice with a malformed code cannot be saved until it is corrected,
//     rather than being silently rewritten to a taxable code;
//   · retention must be a finite number and must not be NEGATIVE (ADR-38 D6).
//     A negative retention makes the payable exceed the gross invoice value.
//     `invoiceTotals` does NOT defend against this — it clamps only the upper
//     bound (retention above subtotal falls to subtotal), which is deliberate
//     and unchanged — so the floor is enforced here, before any write, rather
//     than resting on the editor's `min="0"` attribute alone.
//
// Deliberately NOT blocked, matching create: a duplicate supplier reference and
// over-invoicing against the PO both stay amber warnings (ADR-38 D3).
//
// CREATE keeps its own inline validity check unchanged (ADR-38: preserve create
// behaviour exactly). Its seeds make the tax-code and retention clauses vacuous
// there in any case — every created line is seeded with a valid code, and the
// retention input is bounded by the browser's constraint validation.
export function validateInvoiceDraft({
  lineItems, supplierInvoiceNumber, invoiceDate, retention = 0, authoredLines = true,
} = {}) {
  const lines = Array.isArray(lineItems) ? lineItems : []
  if (lines.length === 0) return 'A supplier invoice needs at least one line'
  if (!String(supplierInvoiceNumber ?? '').trim()) return "The supplier's invoice number is required"
  if (!String(invoiceDate ?? '').trim()) return 'An invoice date is required'

  if (authoredLines) {
    const badTax = lines.findIndex(li => !TAX_CODES.includes(li?.taxCode))
    if (badTax !== -1) {
      return `Line ${badTax + 1}: choose a tax code (${TAX_CODE_LABELS[TAX_CODE.GST]}, ${TAX_CODE_LABELS[TAX_CODE.GST_FREE]} or ${TAX_CODE_LABELS[TAX_CODE.INPUT_TAXED]})`
    }
    const retentionError = retentionFloorError(retention)
    if (retentionError) return retentionError
  }

  if (!lines.some(li => (Number(li?.amount) || 0) > 0)) {
    return 'A supplier invoice must carry an amount on at least one line'
  }
  return null
}

// The header money fields a rebuild must reproduce exactly for a claim-sourced
// invoice. Ordered so the message names the most meaningful drift first.
const CLAIM_SOURCED_FROZEN_TOTALS = [
  ['payableTotal',   'payable total'],
  ['payableGst',     'payable GST'],
  ['subtotal',       'subtotal'],
  ['gstTotal',       'GST total'],
  ['grossTotal',     'gross total'],
  ['retention',      'retention'],
  ['retentionGst',   'retention GST'],
  ['retentionTotal', 'retention total'],
  ['net',            'net'],
]

// DEFENCE IN DEPTH for the claim-sourced reconciliation invariant (ADR-38).
//
// A `progress_claim` invoice must keep paying exactly the approved claim's
// certified GST and total — that is checked against the live claim at CREATE
// (claimReconciliationError) and must not be breakable afterwards. Draft editing
// makes it structurally unbreakable: the editor exposes no line, tax or retention
// control on this path, and the update contract writes no financial field.
//
// This is the belt to that braces. It rebuilds the stored lines and refuses the
// save if ANY stored header total fails to reproduce — which happens only when
// the stored document is already internally inconsistent (a legacy or forged
// `gstAmount` that disagrees with its own amount + tax code, or a missing total).
// Such a draft is refused with a clear message rather than being mutated into
// agreement, because rewriting it would move money the user never authored.
//
// It reads the invoice's OWN stored totals, never the progress claim, so normal
// editing needs no live-claim dependency: approved claim amounts are frozen
// forever, so the stored figures ARE the certified figures.
export function claimSourcedDriftError(invoice, totals) {
  if (!isClaimSourced(invoice)) return null
  for (const [key, label] of CLAIM_SOURCED_FROZEN_TOTALS) {
    const stored = Number(invoice?.[key])
    if (!Number.isFinite(stored)) {
      return `${invoice?.invoiceNumber || 'This invoice'} is missing its stored ${label} and cannot be safely edited. Cancel it and raise a new invoice from the claim.`
    }
    if (roundMoney(stored) !== roundMoney(Number(totals?.[key]) || 0)) {
      return `${invoice?.invoiceNumber || 'This invoice'} no longer reconciles to its approved claim (${label} ${roundMoney(stored)} vs ${roundMoney(Number(totals?.[key]) || 0)}). Cancel it and raise a new invoice from the claim.`
    }
  }
  return null
}

// ── Read-time budget derivations ─────────────────────────────────────────────

// { costCodeId: ex-GST amount } across counting (posted/paid) invoices. Feeds
// the budget Invoiced column and the invoice side of Actual — never stored.
export function invoicedByCostCode(invoices) {
  const map = {}
  for (const inv of invoices) {
    if (!SI_COUNTING_STATUSES.includes(inv.status)) continue
    for (const li of inv.lineItems ?? []) {
      if (!li.costCodeId) continue
      map[li.costCodeId] = roundMoney((map[li.costCodeId] || 0) + (Number(li.amount) || 0))
    }
  }
  return map
}

// { poId: { poLineIndex: ex-GST posted/paid amount } } — invoiced-to-date per PO
// line. Drives Committed maturing (remaining open commitment) in purchaseOrders.
export function postedInvoicedByPoLine(invoices) {
  const map = {}
  for (const inv of invoices) {
    if (!SI_COUNTING_STATUSES.includes(inv.status)) continue
    if (!inv.poId) continue
    const forPo = map[inv.poId] ?? (map[inv.poId] = {})
    for (const li of inv.lineItems ?? []) {
      if (li.poLineIndex == null) continue
      forPo[li.poLineIndex] = roundMoney((forPo[li.poLineIndex] || 0) + (Number(li.amount) || 0))
    }
  }
  return map
}

// { poId: ex-GST posted/paid total } — invoiced-to-date per PO, for the
// over-invoicing warning against the PO total.
export function postedInvoicedByPo(invoices) {
  const map = {}
  for (const inv of invoices) {
    if (!SI_COUNTING_STATUSES.includes(inv.status)) continue
    if (!inv.poId) continue
    for (const li of inv.lineItems ?? []) {
      map[inv.poId] = roundMoney((map[inv.poId] || 0) + (Number(li.amount) || 0))
    }
  }
  return map
}

// Claim ids referenced by a counting (posted/paid) invoice. Those claims are
// excluded from the claim side of Actual so the posted invoice replaces them
// without double-counting — the claim document is never mutated.
export function invoicedClaimIds(invoices) {
  const set = new Set()
  for (const inv of invoices) {
    if (!SI_COUNTING_STATUSES.includes(inv.status)) continue
    if (inv.progressClaimId) set.add(inv.progressClaimId)
  }
  return set
}

// ── Dates ────────────────────────────────────────────────────────────────────

const pad2 = (n) => String(n).padStart(2, '0')
const toIsoDate = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`

// Suggests a due date from the invoice date and the supplier's payment terms.
// basis 'invoice' → invoiceDate + days; 'eom' → end of invoice month + days.
// Returns a 'YYYY-MM-DD' string, or '' when inputs are insufficient.
export function suggestDueDate(invoiceDate, paymentTerms) {
  if (!invoiceDate || !paymentTerms || !Number.isFinite(Number(paymentTerms.days))) return ''
  const base = new Date(`${invoiceDate}T00:00:00`)
  if (Number.isNaN(base.getTime())) return ''
  const days = Number(paymentTerms.days)
  if (paymentTerms.basis === 'eom') {
    const eom = new Date(base.getFullYear(), base.getMonth() + 1, 0)
    eom.setDate(eom.getDate() + days)
    return toIsoDate(eom)
  }
  base.setDate(base.getDate() + days)
  return toIsoDate(base)
}

// An invoice is overdue when it has a due date in the past and is neither paid
// nor cancelled. Uses a plain date comparison (dueDate is a 'YYYY-MM-DD' string).
//
// ⚠️ DATE-ONLY — NOT SUITABLE FOR PAYMENT-AWARE FIGURES OR BADGES. This function
// has no knowledge of Supplier Payments, so it reports a fully-paid invoice as
// overdue whenever its due date has passed. Its behaviour is deliberately
// unchanged for backwards compatibility, and the `SI_STATUS.PAID` guard below is
// vestigial (nothing writes that status — see ADR-24).
//
// Anything presenting a past-due amount, badge, or filter must use
// `isPastDuePayable(invoice, remainingPayable, now)` in lib/supplierPayments.js,
// which additionally requires the invoice to be POSTED and still payable. This
// mirrors the deliberate `isPastDue` / `isPastDueUnreconciled` split already in
// place on the accounts-receivable side.
export function isOverdue(invoice, now = new Date()) {
  if (!invoice?.dueDate) return false
  if (invoice.status === SI_STATUS.PAID || invoice.status === SI_STATUS.CANCELLED) return false
  const due = new Date(`${invoice.dueDate}T00:00:00`)
  if (Number.isNaN(due.getTime())) return false
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  return due < today
}
