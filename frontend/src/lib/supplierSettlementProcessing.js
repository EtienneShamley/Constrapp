import { SI_STATUS, TAX_CODES } from './supplierInvoices'
import { SCN_STATUS, SCN_DOC_TYPE, SUPPLIER_CREDIT_NOTE_COUNTER_ID, MAX_CREDIT_NOTE_LINES } from './supplierCreditNotes'
import { RR_STATUS, RR_DOC_TYPE, RETENTION_RELEASE_COUNTER_ID } from './retention'
import { SUPPLIER_PAYMENT_COUNTER_ID, SP_DOC_TYPE, supplierMatchesInvoice } from './supplierPayments'
import { PAYMENT_STATUS, PAYMENT_METHODS, PAYMENT_METHOD, MAX_ALLOCATIONS } from './payments'
import { CURRENT_CALC_VERSION, calcVersionOf, roundToCents } from './supplierCalc'
import {
  supplierInvoiceFigures, allocateSupplierCredit, allocateSupplierRelease, supplierLedgerProblem,
  applySupplierCredit, applySupplierCreditVoid, applySupplierRelease, applySupplierReleaseVoid,
  applySupplierPayment, applySupplierPaymentVoid, paymentAllocationProblem, releaseVoidDependency,
  correctiveVoidProblem,
} from './supplierLedger'
import { toCents, fromCents, isWholeCents } from './money'

// ── Supplier settlement on the trusted boundary (Phase 2 step 4, ADR-94) ─────
//
// PURE — shared by the browser and the trusted backend. Supplier credit notes,
// retention releases and supplier payments are created, edited, POSTED and
// VOIDED only by the backend; posting and voiding move the invoice's ledger
// (lib/supplierLedger.js) in the same transaction. A draft carries the figures
// the ledger produced when it was saved; POSTING re-derives them against the
// ledger as it stands and refuses when they moved (the user re-saves and
// reviews), so a posted document always carries exactly what was reviewed and
// what the ledger accepts.

export const SETTLEMENT_ROLES = ['company_admin', 'project_manager', 'qs']
export const SETTLEMENT_TEXT_MAX = 200
export const SETTLEMENT_NOTES_MAX = 5000
export const SETTLEMENT_COUNTER_ID = {
  credit: SUPPLIER_CREDIT_NOTE_COUNTER_ID,
  release: RETENTION_RELEASE_COUNTER_ID,
  payment: SUPPLIER_PAYMENT_COUNTER_ID,
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const exactKeys = (data, keys) => isObject(data) && Object.keys(data).length === keys.length && keys.every(k => k in data)
const isId = (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(v)
const isRevision = (v) => Number.isInteger(v) && v >= 0 && v <= Number.MAX_SAFE_INTEGER
const DATE_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/
const isDate = (v) => typeof v === 'string' && DATE_RE.test(v)
const isText = (v, max) => typeof v === 'string' && v.length <= max
const isMoney = (v) => typeof v === 'number' && Number.isFinite(v) && isWholeCents(v) && roundToCents(v) !== null

export const SETTLEMENT_PROBLEM = {
  INVOICE_INVALID: 'invoice-invalid',
  LEDGER:          'ledger-inconsistent',
  CAP:             'cap-exceeded',
  DRAFT_INVALID:   'draft-invalid',
  FIGURES_MOVED:   'figures-moved',
  DEPENDENCY:      'dependency',
  FUTURE_DATED:    'future-dated',
  SUPPLIER:        'supplier-invalid',
}
const problem = (code, message, extra = {}) => ({ problem: code, message, ...extra })

// ── Requests ─────────────────────────────────────────────────────────────────

export const CREDIT_DRAFT_KEYS = ['projectId', 'creditNoteId', 'expectedRevision', 'supplierInvoiceId', 'supplierCreditReference', 'creditDate', 'reason', 'notes', 'lines']
export const CREDIT_LINE_KEYS = ['costCodeId', 'taxCode', 'description', 'amount']
export const RELEASE_DRAFT_KEYS = ['projectId', 'releaseId', 'expectedRevision', 'supplierInvoiceId', 'amount', 'releaseDate', 'reason', 'notes']
export const PAYMENT_DRAFT_KEYS = ['projectId', 'paymentId', 'expectedRevision', 'supplierId', 'paymentDate', 'amount', 'paymentMethod',
  'paymentMethodOther', 'bankReference', 'remittanceReference', 'externalReference', 'notes', 'allocations']
export const ALLOCATION_KEYS = ['supplierInvoiceId', 'allocatedAmount']
export const SETTLEMENT_POST_KEYS = ['projectId', 'documentId', 'expectedRevision']
export const SETTLEMENT_VOID_KEYS = ['projectId', 'documentId', 'expectedRevision', 'voidReason']

// `expectedRevision` is null on a CREATE and the edited revision on an UPDATE.
const revisionOrNull = (v) => v === null || isRevision(v)

export function creditDraftRequestProblem(d) {
  if (!exactKeys(d, CREDIT_DRAFT_KEYS)) return 'keys'
  if (!isId(d.projectId) || !isId(d.creditNoteId) || !isId(d.supplierInvoiceId)) return 'ids'
  if (!revisionOrNull(d.expectedRevision)) return 'expectedRevision'
  if (!isText(d.supplierCreditReference, SETTLEMENT_TEXT_MAX)) return 'supplierCreditReference'
  if (!isDate(d.creditDate)) return 'creditDate'
  if (!isText(d.reason, SETTLEMENT_NOTES_MAX) || d.reason.trim() === '') return 'reason'
  if (!isText(d.notes, SETTLEMENT_NOTES_MAX)) return 'notes'
  if (!Array.isArray(d.lines) || d.lines.length === 0 || d.lines.length > MAX_CREDIT_NOTE_LINES) return 'lines'
  for (const l of d.lines) {
    if (!exactKeys(l, CREDIT_LINE_KEYS) || !isId(l.costCodeId) || !TAX_CODES.includes(l.taxCode)) return 'line'
    if (!isText(l.description, SETTLEMENT_TEXT_MAX) || l.description.trim() === '') return 'line-description'
    if (!isMoney(l.amount) || l.amount <= 0) return 'line-amount'
  }
  return null
}

export function releaseDraftRequestProblem(d) {
  if (!exactKeys(d, RELEASE_DRAFT_KEYS)) return 'keys'
  if (!isId(d.projectId) || !isId(d.releaseId) || !isId(d.supplierInvoiceId)) return 'ids'
  if (!revisionOrNull(d.expectedRevision)) return 'expectedRevision'
  if (!isMoney(d.amount) || d.amount <= 0) return 'amount'
  if (!isDate(d.releaseDate)) return 'releaseDate'
  if (!isText(d.reason, SETTLEMENT_NOTES_MAX) || d.reason.trim() === '') return 'reason'
  if (!isText(d.notes, SETTLEMENT_NOTES_MAX)) return 'notes'
  return null
}

export function paymentDraftRequestProblem(d) {
  if (!exactKeys(d, PAYMENT_DRAFT_KEYS)) return 'keys'
  if (!isId(d.projectId) || !isId(d.paymentId) || !isId(d.supplierId)) return 'ids'
  if (!revisionOrNull(d.expectedRevision)) return 'expectedRevision'
  if (!isDate(d.paymentDate)) return 'paymentDate'
  if (!isMoney(d.amount) || d.amount <= 0) return 'amount'
  if (!PAYMENT_METHODS.includes(d.paymentMethod)) return 'paymentMethod'
  if (!isText(d.paymentMethodOther, SETTLEMENT_TEXT_MAX) || (d.paymentMethod === PAYMENT_METHOD.OTHER && d.paymentMethodOther.trim() === '')) return 'paymentMethodOther'
  for (const k of ['bankReference', 'remittanceReference', 'externalReference']) if (!isText(d[k], SETTLEMENT_TEXT_MAX)) return k
  if (!isText(d.notes, SETTLEMENT_NOTES_MAX)) return 'notes'
  if (!Array.isArray(d.allocations) || d.allocations.length > MAX_ALLOCATIONS) return 'allocations'
  const seen = new Set()
  let total = 0
  for (const a of d.allocations) {
    if (!exactKeys(a, ALLOCATION_KEYS) || !isId(a.supplierInvoiceId) || !isMoney(a.allocatedAmount) || a.allocatedAmount <= 0) return 'allocation'
    if (seen.has(a.supplierInvoiceId)) return 'allocation-duplicate'
    seen.add(a.supplierInvoiceId)
    total += toCents(a.allocatedAmount)
  }
  if (total > toCents(d.amount)) return 'allocations-exceed-amount'
  return null
}

export function settlementPostRequestProblem(d) {
  if (!exactKeys(d, SETTLEMENT_POST_KEYS)) return 'keys'
  if (!isId(d.projectId) || !isId(d.documentId)) return 'ids'
  return isRevision(d.expectedRevision) ? null : 'expectedRevision'
}

export function settlementVoidRequestProblem(d) {
  if (!exactKeys(d, SETTLEMENT_VOID_KEYS)) return 'keys'
  if (!isId(d.projectId) || !isId(d.documentId)) return 'ids'
  if (!isRevision(d.expectedRevision)) return 'expectedRevision'
  if (!isText(d.voidReason, SETTLEMENT_NOTES_MAX) || d.voidReason.trim() === '') return 'voidReason'
  return null
}

// ── Shared checks ────────────────────────────────────────────────────────────

// The invoice a credit or release targets: posted, currency recorded, and
// reconciling with itself. Returns { figures } or a problem.
function settleableInvoice(invoice) {
  if (!invoice) return problem(SETTLEMENT_PROBLEM.INVOICE_INVALID, 'The supplier invoice could not be found on this project.')
  if (invoice.status !== SI_STATUS.POSTED) return problem(SETTLEMENT_PROBLEM.INVOICE_INVALID, `${invoice.invoiceNumber || 'The invoice'} is ${invoice.status} — only posted supplier invoices can be settled.`)
  const figures = supplierInvoiceFigures(invoice)
  if (figures.problem) return problem(SETTLEMENT_PROBLEM.INVOICE_INVALID, figures.problem)
  return { figures }
}

function usableLedger(ledgerEntry) {
  if (ledgerEntry?.state === 'inconsistent') return problem(SETTLEMENT_PROBLEM.LEDGER, `This invoice’s settlement history is inconsistent: ${ledgerEntry.problem}`)
  return null
}

// ── Credit notes ─────────────────────────────────────────────────────────────

function creditFigures(invoice, ledger, lines) {
  const target = settleableInvoice(invoice)
  if (target.problem) return target
  const alloc = allocateSupplierCredit(target.figures, ledger, lines.map(l => ({ costCodeId: l.costCodeId, taxCode: l.taxCode, amount: l.amount })))
  if (alloc.error) return problem(SETTLEMENT_PROBLEM.CAP, alloc.error)
  const descriptions = new Map(lines.map(l => [`${l.costCodeId}|${l.taxCode}`, l.description.trim()]))
  return {
    figures: target.figures,
    derived: {
      lineItems: alloc.lines.map(l => ({
        costCodeId: l.costCodeId, costCodeName: l.costCodeName, description: descriptions.get(`${l.costCodeId}|${l.taxCode}`) ?? '',
        amount: fromCents(l.amountCents), taxCode: l.taxCode, gstAmount: fromCents(l.gstCents),
      })),
      subtotal: fromCents(alloc.subtotalCents), gstTotal: fromCents(alloc.gstCents), grossTotal: fromCents(alloc.subtotalCents + alloc.gstCents),
      retentionAmount: fromCents(alloc.retentionCents), retentionGst: fromCents(alloc.retentionGstCents),
      calcVersion: CURRENT_CALC_VERSION, sourceCalcVersion: invoice.calcVersion == null ? null : calcVersionOf(invoice),
    },
  }
}

export function buildCreditDraft({ input, invoice, ledgerEntry, creditNumber, uid, now }) {
  const bad = usableLedger(ledgerEntry)
  if (bad) return bad
  const built = creditFigures(invoice, ledgerEntry.ledger, input.lines)
  if (built.problem) return built
  return {
    document: {
      creditNumber, status: SCN_STATUS.DRAFT, docType: SCN_DOC_TYPE.CREDIT_NOTE,
      supplierInvoiceId: invoice.id, invoiceNumber: invoice.invoiceNumber || '', supplierInvoiceNumber: invoice.supplierInvoiceNumber || '',
      supplierId: invoice.supplierId ?? null, supplierName: String(invoice.supplierName || '').trim(),
      supplierCreditReference: input.supplierCreditReference.trim(), creditDate: input.creditDate, reason: input.reason.trim(),
      ...built.derived, currency: invoice.currency, revision: 1, notes: input.notes.trim(),
      postedAt: null, postedBy: null, voidedAt: null, voidedBy: null, voidReason: '',
      attachments: [], externalRefs: {}, createdAt: now, createdBy: uid, updatedAt: now, updatedBy: uid,
    },
  }
}

export function buildCreditDraftUpdate({ input, live, invoice, ledgerEntry, uid, now }) {
  if (live.supplierInvoiceId !== input.supplierInvoiceId) return problem(SETTLEMENT_PROBLEM.DRAFT_INVALID, 'A credit note’s invoice cannot be changed — void or discard the draft and raise a new one.')
  const bad = usableLedger(ledgerEntry)
  if (bad) return bad
  const built = creditFigures(invoice, ledgerEntry.ledger, input.lines)
  if (built.problem) return built
  return {
    update: {
      supplierCreditReference: input.supplierCreditReference.trim(), creditDate: input.creditDate, reason: input.reason.trim(), notes: input.notes.trim(),
      ...built.derived, revision: (Number(live.revision) || 0) + 1, updatedAt: now, updatedBy: uid,
    },
  }
}

const sameFigures = (live, derived, keys) => keys.every(k => JSON.stringify(live?.[k] ?? null) === JSON.stringify(derived[k] ?? null))
const CREDIT_FIGURE_KEYS = ['lineItems', 'subtotal', 'gstTotal', 'grossTotal', 'retentionAmount', 'retentionGst']

// Posting a draft credit: the figures re-derived NOW must be the draft's.
export function creditPosting({ live, invoice, ledgerEntry }) {
  const bad = usableLedger(ledgerEntry)
  if (bad) return bad
  const rows = (live.lineItems ?? []).map(l => ({ costCodeId: l.costCodeId, taxCode: l.taxCode, description: l.description ?? '', amount: l.amount }))
  const built = creditFigures(invoice, ledgerEntry.ledger, rows)
  if (built.problem) return built
  if (!sameFigures(live, built.derived, CREDIT_FIGURE_KEYS)) {
    return problem(SETTLEMENT_PROBLEM.FIGURES_MOVED, 'The invoice’s credits or releases changed since this draft was saved, so its GST or retention split would differ. Open and save the draft again, review it, then post.')
  }
  const next = applySupplierCredit(ledgerEntry.ledger, { ...live, id: live.id })
  const invariant = supplierLedgerProblem(built.figures, next)
  if (invariant) return problem(SETTLEMENT_PROBLEM.CAP, invariant)
  return { ledger: next }
}

export function creditVoiding({ live, invoice, ledgerEntry }) {
  const figures = supplierInvoiceFigures(invoice)
  if (figures.problem) return problem(SETTLEMENT_PROBLEM.INVOICE_INVALID, figures.problem)
  const next = applySupplierCreditVoid(ledgerEntry.ledger, { ...live, id: live.id })
  const refused = voidRefusal(figures, ledgerEntry, next)
  if (refused) return problem(SETTLEMENT_PROBLEM.DEPENDENCY, `Voiding this credit note is refused: ${refused}`)
  return { ledger: next }
}

// THE VOID RULE (ADR-94). On an ESTABLISHED ledger the state after the void
// must satisfy every invariant. On a ledger history left INCONSISTENT a void is
// the only supported correction, and only a CORRECTIVE one is accepted: no
// figure negative, no invariant breach wider than before, no new breach
// (supplierLedger.correctiveVoidProblem). Anything else fails closed — there is
// no other repair path. Whether the ledger is established again afterwards is
// decided by the backend from the state it then holds (and from any malformed
// historical entry still posted), never assumed here.
function voidRefusal(figures, ledgerEntry, next) {
  const invariant = supplierLedgerProblem(figures, next)
  if (!invariant) return null
  if (ledgerEntry.state !== 'inconsistent') return invariant
  return correctiveVoidProblem(figures, ledgerEntry.ledger, next)
}

// ── Retention releases ───────────────────────────────────────────────────────

function releaseFigures(invoice, ledger, amount) {
  const target = settleableInvoice(invoice)
  if (target.problem) return target
  if (target.figures.R <= 0) return problem(SETTLEMENT_PROBLEM.INVOICE_INVALID, `${invoice.invoiceNumber || 'The invoice'} holds no retention.`)
  const alloc = allocateSupplierRelease(target.figures, ledger, amount)
  if (alloc.error) return problem(SETTLEMENT_PROBLEM.CAP, alloc.error)
  return {
    figures: target.figures,
    derived: {
      previouslyReleasedAmount: fromCents(ledger.releasedRetentionCents),
      amount: fromCents(alloc.amountCents), gstAmount: fromCents(alloc.gstCents), releaseTotal: fromCents(alloc.amountCents + alloc.gstCents),
      calcVersion: CURRENT_CALC_VERSION, sourceCalcVersion: invoice.calcVersion == null ? null : calcVersionOf(invoice),
    },
  }
}

export function buildReleaseDraft({ input, invoice, ledgerEntry, releaseNumber, currency, uid, now }) {
  const bad = usableLedger(ledgerEntry)
  if (bad) return bad
  const built = releaseFigures(invoice, ledgerEntry.ledger, input.amount)
  if (built.problem) return built
  return {
    document: {
      releaseNumber, status: RR_STATUS.DRAFT, docType: RR_DOC_TYPE,
      supplierInvoiceId: invoice.id, invoiceNumber: invoice.invoiceNumber || '', supplierInvoiceNumber: invoice.supplierInvoiceNumber || '',
      supplierId: invoice.supplierId ?? null, supplierName: String(invoice.supplierName || '').trim(),
      ...built.derived, releaseDate: input.releaseDate, reason: input.reason.trim(), notes: input.notes.trim(),
      currency, revision: 1, postedAt: null, postedBy: null, voidedAt: null, voidedBy: null, voidReason: '',
      externalRefs: {}, createdAt: now, createdBy: uid, updatedAt: now, updatedBy: uid,
    },
  }
}

export function buildReleaseDraftUpdate({ input, live, invoice, ledgerEntry, uid, now }) {
  if (live.supplierInvoiceId !== input.supplierInvoiceId) return problem(SETTLEMENT_PROBLEM.DRAFT_INVALID, 'A release’s invoice cannot be changed — raise a new release.')
  const bad = usableLedger(ledgerEntry)
  if (bad) return bad
  const built = releaseFigures(invoice, ledgerEntry.ledger, input.amount)
  if (built.problem) return built
  return {
    update: {
      ...built.derived, releaseDate: input.releaseDate, reason: input.reason.trim(), notes: input.notes.trim(),
      revision: (Number(live.revision) || 0) + 1, updatedAt: now, updatedBy: uid,
    },
  }
}

const RELEASE_FIGURE_KEYS = ['previouslyReleasedAmount', 'amount', 'gstAmount', 'releaseTotal']

export function releasePosting({ live, invoice, ledgerEntry }) {
  const bad = usableLedger(ledgerEntry)
  if (bad) return bad
  const built = releaseFigures(invoice, ledgerEntry.ledger, live.amount)
  if (built.problem) return built
  if (!sameFigures(live, built.derived, RELEASE_FIGURE_KEYS)) {
    return problem(SETTLEMENT_PROBLEM.FIGURES_MOVED, 'Retention on this invoice changed since the draft was saved. Open and save the draft again, review it, then post.')
  }
  const next = applySupplierRelease(ledgerEntry.ledger, { ...live, id: live.id })
  const invariant = supplierLedgerProblem(built.figures, next)
  if (invariant) return problem(SETTLEMENT_PROBLEM.CAP, invariant)
  return { ledger: next }
}

export function releaseVoiding({ live, invoice, ledgerEntry }) {
  const figures = supplierInvoiceFigures(invoice)
  if (figures.problem) return problem(SETTLEMENT_PROBLEM.INVOICE_INVALID, figures.problem)
  const next = applySupplierReleaseVoid(ledgerEntry.ledger, { ...live, id: live.id })
  // A payment that depends on the release refuses the void in EVERY state.
  const dependency = releaseVoidDependency(figures, ledgerEntry.ledger, { ...live, id: live.id }, invoice.invoiceNumber)
  if (dependency) return problem(SETTLEMENT_PROBLEM.DEPENDENCY, dependency)
  const refused = voidRefusal(figures, ledgerEntry, next)
  if (refused) return problem(SETTLEMENT_PROBLEM.DEPENDENCY, `Voiding this release is refused: ${refused}`)
  return { ledger: next }
}

// ── Payments ─────────────────────────────────────────────────────────────────

// The stored payment from a request, the supplier contact and the invoices
// the allocations name. Allocations are checked for target and supplier here;
// the remaining-payable cap is authoritative at POSTING (the ledger moves only
// then), and is previewed here so a draft never knowingly over-allocates.
export function buildPaymentFields({ input, supplier, invoices, ledgers }) {
  if (!supplier || supplier.isActive === false) return problem(SETTLEMENT_PROBLEM.SUPPLIER, 'The selected supplier could not be found or is inactive.')
  const supplierName = String(supplier.displayName || supplier.legalName || '').trim()
  if (supplierName === '') return problem(SETTLEMENT_PROBLEM.SUPPLIER, 'The selected supplier has no display name.')
  const allocations = []
  for (const [i, a] of input.allocations.entries()) {
    const inv = invoices.get(a.supplierInvoiceId) ?? null
    if (!inv) return problem(SETTLEMENT_PROBLEM.INVOICE_INVALID, `Allocation ${i + 1}: the supplier invoice could not be found on this project.`)
    if (inv.status !== SI_STATUS.POSTED) return problem(SETTLEMENT_PROBLEM.INVOICE_INVALID, `${inv.invoiceNumber} is ${inv.status} — only posted supplier invoices can be paid.`)
    if (!supplierMatchesInvoice(inv, input.supplierId, supplierName)) return problem(SETTLEMENT_PROBLEM.SUPPLIER, `${inv.invoiceNumber} belongs to a different supplier.`)
    const entry = ledgers.get(a.supplierInvoiceId)
    const bad = usableLedger(entry)
    if (bad) return bad
    const figures = supplierInvoiceFigures(inv)
    if (figures.problem) return problem(SETTLEMENT_PROBLEM.INVOICE_INVALID, figures.problem)
    const cap = paymentAllocationProblem(figures, entry.ledger, toCents(a.allocatedAmount), inv.invoiceNumber)
    if (cap) return problem(SETTLEMENT_PROBLEM.CAP, cap)
    allocations.push({ supplierInvoiceId: inv.id, invoiceNumber: inv.invoiceNumber || '', supplierInvoiceNumber: inv.supplierInvoiceNumber || '', allocatedAmount: fromCents(toCents(a.allocatedAmount)) })
  }
  const allocatedCents = allocations.reduce((s, a) => s + toCents(a.allocatedAmount), 0)
  return {
    fields: {
      supplierId: input.supplierId, supplierName, paymentDate: input.paymentDate, amount: fromCents(toCents(input.amount)),
      paymentMethod: input.paymentMethod, paymentMethodOther: input.paymentMethod === PAYMENT_METHOD.OTHER ? input.paymentMethodOther.trim() : '',
      bankReference: input.bankReference.trim(), remittanceReference: input.remittanceReference.trim(), externalReference: input.externalReference.trim(),
      allocations, allocatedTotal: fromCents(allocatedCents), unallocatedAmount: fromCents(toCents(input.amount) - allocatedCents),
      notes: input.notes.trim(),
    },
  }
}

export function buildPaymentDraft({ fields, paymentNumber, currency, uid, now }) {
  return {
    paymentNumber, status: PAYMENT_STATUS.DRAFT, docType: SP_DOC_TYPE.PAYMENT, ...fields,
    currency, revision: 1, postedAt: null, postedBy: null, voidedAt: null, voidedBy: null, voidReason: '',
    attachments: [], externalRefs: {}, createdAt: now, createdBy: uid, updatedAt: now, updatedBy: uid,
  }
}

// The latest calendar date a payment may be POSTED with: the server's UTC date
// plus one day (a payment records money that has left the account; the day of
// the earliest-ahead supported timezone is accepted, and no later).
export function latestPostableDate(nowMillis) {
  const d = new Date(nowMillis + 24 * 60 * 60 * 1000)
  return d.toISOString().slice(0, 10)
}

// Posting a draft payment: each allocation moves its invoice's ledger; the cap
// is re-checked against every ledger AS IT STANDS. Returns { ledgers: Map } of
// the next states, or a problem.
export function paymentPosting({ live, invoices, ledgers, nowMillis }) {
  if (typeof live.paymentDate !== 'string' || live.paymentDate > latestPostableDate(nowMillis)) {
    return problem(SETTLEMENT_PROBLEM.FUTURE_DATED, `The payment date (${live.paymentDate}) is in the future. A payment records money already paid; post it on or after that date.`)
  }
  const allocations = Array.isArray(live.allocations) ? live.allocations : []
  const allocatedCents = allocations.reduce((s, a) => s + toCents(a?.allocatedAmount), 0)
  if (allocatedCents + toCents(live.unallocatedAmount) !== toCents(live.amount) || toCents(live.allocatedTotal) !== allocatedCents) {
    return problem(SETTLEMENT_PROBLEM.DRAFT_INVALID, 'The payment’s allocated and unallocated amounts do not add up to its amount. Open and save it again.')
  }
  const next = new Map()
  for (const a of allocations) {
    const inv = invoices.get(a?.supplierInvoiceId) ?? null
    if (!inv || inv.status !== SI_STATUS.POSTED) return problem(SETTLEMENT_PROBLEM.INVOICE_INVALID, `${a?.invoiceNumber || 'An allocated invoice'} is no longer a posted supplier invoice.`)
    if (!supplierMatchesInvoice(inv, live.supplierId, live.supplierName)) return problem(SETTLEMENT_PROBLEM.SUPPLIER, `${inv.invoiceNumber} belongs to a different supplier.`)
    const entry = ledgers.get(inv.id)
    const bad = usableLedger(entry)
    if (bad) return bad
    const figures = supplierInvoiceFigures(inv)
    if (figures.problem) return problem(SETTLEMENT_PROBLEM.INVOICE_INVALID, figures.problem)
    const cents = toCents(a.allocatedAmount)
    if (!isWholeCents(a.allocatedAmount) || cents <= 0) return problem(SETTLEMENT_PROBLEM.DRAFT_INVALID, `The allocation to ${inv.invoiceNumber} is not a positive whole number of cents.`)
    // A stored payment may name one invoice more than once (a draft written
    // before the backend owned payments): each allocation is checked against,
    // and applied on, the ledger as the EARLIER allocations left it.
    const current = next.get(inv.id) ?? entry.ledger
    const cap = paymentAllocationProblem(figures, current, cents, inv.invoiceNumber)
    if (cap) return problem(SETTLEMENT_PROBLEM.CAP, cap)
    next.set(inv.id, applySupplierPayment(current, cents, live.id))
  }
  return { ledgers: next }
}

export function paymentVoiding({ live, ledgers }) {
  const next = new Map()
  for (const a of Array.isArray(live.allocations) ? live.allocations : []) {
    const entry = ledgers.get(a?.supplierInvoiceId)
    const cents = toCents(a?.allocatedAmount)
    if (!(cents > 0)) return problem(SETTLEMENT_PROBLEM.DEPENDENCY, `The allocation to ${a?.invoiceNumber || 'an invoice'} is not a positive amount — this payment cannot be voided until the history is reviewed.`)
    // Cumulative across allocations naming the same invoice (see paymentPosting).
    const after = applySupplierPaymentVoid(next.get(a.supplierInvoiceId) ?? entry?.ledger ?? { paidCents: 0, seq: 0, groups: {} }, cents, live.id)
    if (after.paidCents < 0) return problem(SETTLEMENT_PROBLEM.DEPENDENCY, `The ledger of ${a?.invoiceNumber || 'an allocated invoice'} records less paid than this payment allocated — it cannot be voided until the history is reviewed.`)
    next.set(a.supplierInvoiceId, after)
  }
  return { ledgers: next }
}
