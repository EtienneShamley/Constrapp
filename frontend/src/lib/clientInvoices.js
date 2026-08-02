import { GST_RATE, roundMoney } from './purchaseOrders'
import { VARIATION_TYPE, VARIATION_APPROVED_STATUSES } from './variations'

// ── Client Invoices (accounts receivable) ────────────────────────────────────
//
// Client invoices are the REVENUE side: what the company has formally billed
// the head-contract client. They are the mirror of supplierInvoices (accounts
// payable) and share none of its documents — a client invoice references the
// project's commercial baseline (contract sum) and approved CLIENT variations,
// never a PO, a progress claim, or a supplier.
//
// All canonical line amounts are ex-GST; GST is derived per line from taxCode
// and stored as gstAmount. Every contract-control and receivables figure below
// is derived at READ TIME from the invoice documents — nothing is written back
// to the baseline, to variations, or to Budget Lines.
//
// ⚠️ NO PAYMENT STATE. Constrapp has no Receipt records, so this module never
// computes "paid", "unpaid", or "amount owing". An issued invoice is "issued,
// not yet reconciled" until the Payments and Receipts foundation lands. Ageing
// here is strictly AGEING BY DUE DATE, not a statement of what is owed.

export const CI_STATUS = {
  DRAFT:  'draft',
  SENT:   'sent',   // reserved — there is no delivery mechanism, so nothing
                    // transitions into it. A `sent` status would assert that a
                    // client received something, which the app cannot evidence.
  ISSUED: 'issued',
  VOID:   'void',
}

export const CI_STATUS_LABELS = {
  [CI_STATUS.DRAFT]:  'Draft',
  [CI_STATUS.SENT]:   'Sent',
  [CI_STATUS.ISSUED]: 'Issued',
  [CI_STATUS.VOID]:   'Void',
}

// Maps each status onto an existing Badge variant — no new colours.
export const CI_BADGE_VARIANTS = {
  [CI_STATUS.DRAFT]:  'soon',
  [CI_STATUS.SENT]:   'info',
  [CI_STATUS.ISSUED]: 'active',
  [CI_STATUS.VOID]:   'danger',
}

// Forward-only lifecycle. `void` is terminal; there is no return to draft and
// no un-issue. Deliberately NO `paid` / `partially_paid` status — not even
// reserved: a payment status without a Receipt record would be fabricated.
//
// Unlike every other collection in this app, these transitions are ALSO
// enforced by Firestore rules (see frontend/firestore.rules → clientInvoices).
// This map stays the single client-side source of truth so the UI and the rules
// cannot drift.
export const CI_TRANSITIONS = {
  [CI_STATUS.DRAFT]:  [CI_STATUS.ISSUED, CI_STATUS.VOID],
  [CI_STATUS.SENT]:   [],
  [CI_STATUS.ISSUED]: [CI_STATUS.VOID],
  [CI_STATUS.VOID]:   [],
}

export const canTransition = (from, to) => (CI_TRANSITIONS[from] ?? []).includes(to)

// The single counting point for every contract-control and receivables figure.
// Drafts are exposure only; void invoices contribute nothing, forever.
export const CI_COUNTING_STATUSES = [CI_STATUS.ISSUED]

// A draft is fully editable; an issued invoice is frozen except the void
// transition (rules-enforced here, not merely client-enforced).
export const CI_EDITABLE_STATUSES = [CI_STATUS.DRAFT]

export const CI_DOC_TYPE = {
  INVOICE:     'invoice',
  CREDIT_NOTE: 'credit_note', // reserved — Credit Notes are a future module
}

export const CLIENT_INVOICE_COUNTER_ID = 'clientInvoices'

export const formatClientInvoiceNumber = (n) => `CI-${String(n).padStart(4, '0')}`

// ── Tax codes ────────────────────────────────────────────────────────────────
// Per-line tax treatment, identical to supplier invoices and variations. Only
// `gst` attracts GST; the others are zero-rated. Storage is always ex-GST plus
// a derived gstAmount per line.
//
// ⚠️ AUSTRALIAN GST ONLY. GST_RATE is a flat 10% and every "GST 10%" label is
// Australian. A project reporting in another currency still applies Australian
// GST rules — see needsTaxLimitationNotice in lib/currency.js.
//
// This helper is duplicated (rather than imported from lib/supplierInvoices.js)
// so the receivables module carries no dependency on the payables module —
// the same precedent lib/variations.js already sets.
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

// ── Header totals (derived from line items) ──────────────────────────────────
// There is no retention and no payable/gross split on the client side in this
// foundation, so the gross total IS the amount billed. (Client retention is a
// separate future foundation.)
export function invoiceTotals(lineItems) {
  const subtotal = roundMoney((lineItems ?? []).reduce((sum, li) => sum + (Number(li.amount) || 0), 0))
  const gstTotal = roundMoney((lineItems ?? []).reduce((sum, li) => sum + (Number(li.gstAmount) || 0), 0))
  return { subtotal, gstTotal, grossTotal: roundMoney(subtotal + gstTotal) }
}

// ── Dates, payment terms, and past-due ───────────────────────────────────────

const pad2 = (n) => String(n).padStart(2, '0')
const toIsoDate = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`

// Suggests a due date from the invoice date and the client's payment terms.
// basis 'invoice' → invoiceDate + days; 'eom' → end of invoice month + days.
// Returns 'YYYY-MM-DD', or '' when the inputs are insufficient — the caller
// then leaves the due date BLANK rather than assuming a default term.
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

// Human wording for a payment-terms map, so the UI can NAME the source of a
// suggested due date instead of applying a hidden default.
export function paymentTermsLabel(paymentTerms) {
  const days = Number(paymentTerms?.days)
  if (!Number.isFinite(days)) return ''
  return paymentTerms.basis === 'eom'
    ? `${days} days after end of month`
    : `${days} days from invoice`
}

// Days a date string is past `now` (negative when still in the future).
// Date-only comparison in the VIEWER'S LOCAL TIMEZONE — there is no timezone
// normalisation, so a due date can read past-due a few hours early or late for
// a user in another timezone. A documented limitation, matching lib/supplierInvoices.
export function daysPastDue(dueDate, now = new Date()) {
  if (!dueDate) return null
  const due = new Date(`${dueDate}T00:00:00`)
  if (Number.isNaN(due.getTime())) return null
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  return Math.round((today - due) / 86400000)
}

// An invoice is PAST ITS DUE DATE when it is issued (drafts are not
// receivables, void invoices are nothing) and its due date has passed.
//
// ⚠️ This is NOT "overdue" in the money sense. Constrapp records no receipts,
// so this says only that a due date has passed — never that a client owes money.
export function isPastDue(invoice, now = new Date()) {
  if (invoice?.status !== CI_STATUS.ISSUED) return false
  const days = daysPastDue(invoice.dueDate, now)
  return days !== null && days > 0
}

// ── Read-time contract control (never stored) ────────────────────────────────

export const issuedClientInvoices = (invoices) =>
  (invoices ?? []).filter(inv => CI_COUNTING_STATUSES.includes(inv.status))

export const draftClientInvoices = (invoices) =>
  (invoices ?? []).filter(inv => inv.status === CI_STATUS.DRAFT)

// Σ across a set of invoices. Header totals are denormalised at write time from
// the lines (the PO/supplier-invoice idiom), so these read the stored headers.
export function sumInvoices(invoices) {
  let subtotal = 0
  let gstTotal = 0
  for (const inv of invoices ?? []) {
    subtotal += Number(inv.subtotal) || 0
    gstTotal += Number(inv.gstTotal) || 0
  }
  subtotal = roundMoney(subtotal)
  gstTotal = roundMoney(gstTotal)
  return { count: (invoices ?? []).length, subtotal, gstTotal, grossTotal: roundMoney(subtotal + gstTotal) }
}

// Available to Invoice = Current Contract Sum − Issued Client Invoices (ex-GST).
// Signed: it goes negative when the contract has been over-invoiced, and is
// never clamped — hiding an over-invoiced position would be the whole problem.
export function availableToInvoice(currentContractSumValue, issuedExGst) {
  return roundMoney((Number(currentContractSumValue) || 0) - (Number(issuedExGst) || 0))
}

// One composite read-time derivation of the contract-control figures, so the
// summary cards and the create/edit modal cannot drift apart.
// `currentContractSumValue` comes from lib/margin.js (baseline + approved client
// variations) — it is NOT recomputed here.
export function contractControl(invoices, currentContractSumValue) {
  const issued = sumInvoices(issuedClientInvoices(invoices))
  const drafts = sumInvoices(draftClientInvoices(invoices))
  return {
    currentContractSum: roundMoney(Number(currentContractSumValue) || 0),
    issued,
    drafts,
    availableToInvoice: availableToInvoice(currentContractSumValue, issued.subtotal),
  }
}

// ── Read-time variation invoicing (never mutates a variation) ────────────────

// Approved CLIENT variations only. Variation documents are never read for
// anything but their frozen approved figures, and are never written to.
export const approvedClientVariations = (variations) =>
  (variations ?? []).filter(v =>
    v.variationType === VARIATION_TYPE.CLIENT && VARIATION_APPROVED_STATUSES.includes(v.status))

// { variationId: Σ ex-GST line amount across ISSUED, non-void invoices }.
// Drafts are excluded — a draft has billed nothing.
export function invoicedByVariation(invoices) {
  const map = {}
  for (const inv of issuedClientInvoices(invoices)) {
    for (const li of inv.lineItems ?? []) {
      if (!li.variationId) continue
      map[li.variationId] = roundMoney((map[li.variationId] || 0) + (Number(li.amount) || 0))
    }
  }
  return map
}

// The cost code an approved client variation "clearly resolves to".
//
// Revenue sits ABOVE the cost-code spine (ADR-20: contract revenue has no cost
// code, exactly as client variations have no PO), so a client invoice line's
// costCodeId is OPTIONAL. A variation-linked line inherits a frozen cost-code
// snapshot ONLY when the whole variation resolves to exactly one cost code;
// when the variation spans several, a single snapshot would be a false
// attribution, so null is stored instead. Direct contract lines are always null
// — users are never made to invent a revenue cost code. (ADR-22.)
export function resolveVariationCostCode(variation) {
  const seen = new Map()
  for (const li of variation?.lineItems ?? []) {
    if (!li.costCodeId) continue
    if (!seen.has(li.costCodeId)) seen.set(li.costCodeId, li.costCodeName || null)
  }
  if (seen.size !== 1) return { costCodeId: null, costCodeName: null }
  const [costCodeId, costCodeName] = [...seen.entries()][0]
  return { costCodeId, costCodeName }
}

// Per approved client variation: approved / invoiced / remaining (all ex-GST).
// `remaining` is signed — it goes negative when a variation has been
// over-invoiced, which is warned, never hidden.
export function variationInvoicingRows(variations, invoices) {
  const invoiced = invoicedByVariation(invoices)
  return approvedClientVariations(variations).map(v => {
    const approved = roundMoney(Number(v.approvedSubtotal) || 0)
    const billed   = roundMoney(invoiced[v.id] || 0)
    const costCode = resolveVariationCostCode(v)
    return {
      id:              v.id,
      variationNumber: v.variationNumber,
      title:           v.title || '',
      approved,
      invoiced:        billed,
      remaining:       roundMoney(approved - billed),
      costCodeId:      costCode.costCodeId,
      costCodeName:    costCode.costCodeName,
    }
  })
}

// Approved client variations that may be added as an invoice line.
//
// TWO deliberate exclusions:
//  · PENDING (draft/submitted) client variations are NOT invoiceable — approval
//    is the counting point (ADR-18). Billing unapproved work is exactly the
//    error this guard exists to prevent.
//  · NEGATIVE approved client variations (omissions/credits) are NOT offered —
//    a credit cannot be positively invoiced. They still reduce the Current
//    Contract Sum (and therefore Available to Invoice) through the existing
//    signed approvedClientVariationsTotal; a future Credit Note bills them.
export function invoiceableClientVariations(variations, invoices) {
  return variationInvoicingRows(variations, invoices).filter(r => r.approved > 0)
}

// ── Read-time receivables ageing ─────────────────────────────────────────────
//
// ⚠️ HONEST LABELLING IS PART OF THIS FUNCTION'S CONTRACT. Because no Receipt
// records exist, EVERY issued, non-void invoice appears here until it is
// voided — regardless of whether the client has actually paid. The buckets age
// invoices BY DUE DATE and are not a statement of what is owed. Callers must
// render the accompanying limitation notice; see AR_LIMITATION_NOTICE.
export const AR_LIMITATION_NOTICE =
  'Payments are not yet recorded. Constrapp has no Receipt records, so every issued invoice ' +
  'stays here until it is voided — whether or not the client has paid. These figures age ' +
  'invoices by due date only; they are not a statement of what is owed. Receipts arrive in ' +
  'the Payments and Receipts foundation.'

export const AGEING_BUCKETS = [
  { key: 'noDueDate', label: 'No due date' },
  { key: 'notYetDue', label: 'Not yet due' },
  { key: 'd1_30',     label: 'Past due 1–30 days' },
  { key: 'd31_60',    label: 'Past due 31–60 days' },
  { key: 'd61_90',    label: 'Past due 61–90 days' },
  { key: 'd90plus',   label: 'Past due 90+ days' },
]

const bucketKeyFor = (days) => {
  if (days === null) return 'noDueDate'
  if (days <= 0)  return 'notYetDue'
  if (days <= 30) return 'd1_30'
  if (days <= 60) return 'd31_60'
  if (days <= 90) return 'd61_90'
  return 'd90plus'
}

// Gross (inc. GST) amounts bucketed by due date across ISSUED invoices — gross,
// because that is the figure a client is billed. Returns { key: { amount, count } }
// plus `total` and `pastDue` (everything past its due date).
export function ageingByDueDate(invoices, now = new Date()) {
  const buckets = {}
  for (const b of AGEING_BUCKETS) buckets[b.key] = { amount: 0, count: 0 }

  let total = 0
  let pastDue = 0
  for (const inv of issuedClientInvoices(invoices)) {
    const gross = Number(inv.grossTotal) || 0
    const key   = bucketKeyFor(daysPastDue(inv.dueDate, now))
    buckets[key].amount = roundMoney(buckets[key].amount + gross)
    buckets[key].count += 1
    total = roundMoney(total + gross)
    if (key !== 'noDueDate' && key !== 'notYetDue') pastDue = roundMoney(pastDue + gross)
  }
  return { buckets, total: roundMoney(total), pastDue: roundMoney(pastDue) }
}

// ── Warnings (client-side, warn-only — never blocking) ───────────────────────
//
// ⚠️ NOT ENFORCED. Firestore rules cannot sum sibling documents (no list, query,
// or count), so neither limit below can be enforced server-side, and two users
// can concurrently consume the same remaining availability. These are advisory
// warnings requiring an explicit acknowledgement, never a guarantee. See
// docs/SECURITY.md → Deferred Controls.

// Warns when this invoice would push issued value past the Current Contract Sum.
// Returns null when within the contract value.
export function contractOverInvoiceWarning({ currentContractSum: ccs, issuedExGst, thisInvoiceExGst }) {
  const after = roundMoney((Number(issuedExGst) || 0) + (Number(thisInvoiceExGst) || 0))
  const sum   = roundMoney(Number(ccs) || 0)
  if (after <= sum) return null
  return {
    field: 'contract',
    excess: roundMoney(after - sum),
    message:
      'Issuing this invoice would take total invoiced value above the Current Contract Sum. ' +
      'This is allowed — check for an approved client variation that has not been entered.',
  }
}

// Warns per variation line when this invoice would bill more than a variation's
// approved amount, counting what has already been issued against it.
export function variationOverInvoiceWarnings(lineItems, variations, invoices) {
  const rows = new Map(variationInvoicingRows(variations, invoices).map(r => [r.id, r]))
  const thisInvoiceByVariation = {}
  for (const li of lineItems ?? []) {
    if (!li.variationId) continue
    thisInvoiceByVariation[li.variationId] =
      roundMoney((thisInvoiceByVariation[li.variationId] || 0) + (Number(li.amount) || 0))
  }

  const warnings = []
  for (const [variationId, amount] of Object.entries(thisInvoiceByVariation)) {
    const row = rows.get(variationId)
    if (!row) continue
    if (roundMoney(amount) <= row.remaining) continue
    warnings.push({
      field: 'variation',
      variationId,
      variationNumber: row.variationNumber,
      excess: roundMoney(amount - row.remaining),
      message:
        `${row.variationNumber} would be invoiced beyond its approved amount ` +
        `(${row.remaining} remaining of ${row.approved}). This is allowed, but check for double-invoicing.`,
    })
  }
  return warnings
}

// ── Draft validation (client-side) ───────────────────────────────────────────

// Returns an error message, or null when the draft is saveable. Line totals,
// number uniqueness, and the availability limits above are NOT rules-enforced —
// only these shape checks and the lifecycle rules are.
export function validateInvoiceDraft({ clientId, clientName, invoiceDate, lineItems }) {
  if (!clientId) return 'Select the client this invoice is issued to.'
  if (!(clientName || '').trim()) return 'The selected client has no display name.'
  if (!invoiceDate) return 'Enter an invoice date.'
  const lines = (lineItems ?? []).filter(li => (Number(li.amount) || 0) !== 0)
  if (lines.length === 0) return 'Add at least one line with an amount.'
  for (let i = 0; i < (lineItems ?? []).length; i++) {
    const li = lineItems[i]
    const amount = Number(li.amount)
    if (li.description !== undefined && !String(li.description || '').trim()) {
      return `Line ${i + 1}: enter a description.`
    }
    if (!Number.isFinite(amount)) return `Line ${i + 1}: amount must be a number.`
    if (amount < 0) return `Line ${i + 1}: amount cannot be negative (credits are a future Credit Note).`
    if (!TAX_CODES.includes(li.taxCode)) return `Line ${i + 1}: choose a tax code.`
  }
  return null
}
