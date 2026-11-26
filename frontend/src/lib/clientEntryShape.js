import { isIsoDateShape, isPaymentMethod, PAYMENT_STATUS, MAX_ALLOCATIONS } from './payments'
import { CR_DOC_TYPE } from './clientReceipts'
import { CCN_STATUS, CCN_DOC_TYPE, MAX_CLIENT_CREDIT_LINES } from './clientCreditNotes'
import { CRR_DOC_TYPE } from './clientRetention'

// ── The stored SHAPE of a client credit note, a client retention release and a
// client receipt (ADR-89)
//
// ONE description of what a draft document is, shared by the two places that
// must agree on it:
//   · the browser, which writes drafts (lib/clientLedgerActions.js);
//   · the trusted backend, which posts them and — because Firestore Rules
//     validate very little of a draft — treats the WHOLE document as
//     untrusted: a draft that is not exactly this shape is refused there and
//     nothing is written (functions/src/clientFinance/agreement.js, through
//     the generated bundle).
//
// No figure is defined here. What a figure must EQUAL is the builders' business
// (lib/clientCreditNotes.js, lib/clientRetention.js).

// Bounds on free text. `reason` is the Rules' own bound; the others exist so a
// posted, immutable record cannot carry an unbounded field.
export const CLIENT_ENTRY_LIMITS = {
  REASON:    1000,
  NOTES:     5000,
  REFERENCE: 500,
  LINES:     MAX_CLIENT_CREDIT_LINES,
}

// ── Company activation (ADR-89) ──────────────────────────────────────────────
// Client credit notes and client retention releases are available to a company
// only when its company document carries `clientFinanceEnabled: true` — a field
// no client can write (the company update Rule lists the keys a client may
// change, and this is not one) and only the operator script
// functions/scripts/set-client-finance.mjs sets. Strictly `=== true`: absent,
// null, 'true' and 1 are all OFF. The trusted callables apply this same
// function to the company document they read inside their transaction; in the
// browser it only decides what is OFFERED — it is not a control.
// Client RECEIPTS are not gated: they are an existing workflow of every company.
export const clientFinanceActivated = (companyDoc) => companyDoc?.clientFinanceEnabled === true

// What a draft carries in its lifecycle fields: nothing has happened to it.
export const pristineLifecycle = () => ({ postedAt: null, postedBy: null, voidedAt: null, voidedBy: null, voidReason: '' })

// The target invoice and its snapshots, frozen for the life of the entry.
export const invoiceSnapshot = (invoice) => ({
  clientInvoiceId: invoice.id,
  invoiceNumber:   invoice.invoiceNumber || '',
  clientId:        invoice.clientId ?? null,
  clientName:      invoice.clientName || '',
})

const COMMON_KEYS = [
  'status', 'docType', 'clientInvoiceId', 'invoiceNumber', 'clientId', 'clientName',
  'reason', 'notes', 'ledgerSeq', 'currency', 'revision',
  'postedAt', 'postedBy', 'voidedAt', 'voidedBy', 'voidReason',
  'createdAt', 'createdBy', 'updatedAt', 'updatedBy',
]

// EXACTLY the keys each document carries — no more, no fewer.
export const CLIENT_CREDIT_LINE_KEYS = [
  'invoiceLineIndex', 'description', 'amount', 'taxCode', 'gstAmount',
  'variationId', 'variationNumber', 'costCodeId', 'costCodeName',
]

export const CLIENT_ENTRY_SHAPES = {
  creditNote: {
    docType:   CCN_DOC_TYPE,
    numberKey: 'creditNumber',
    numberPattern: /^CCN-\d{4,}$/,
    dateKey:   'creditDate',
    // Bounded strings beyond `reason`.
    text: { notes: CLIENT_ENTRY_LIMITS.NOTES, clientCreditReference: CLIENT_ENTRY_LIMITS.REFERENCE },
    keys: [
      ...COMMON_KEYS, 'creditNumber', 'creditDate', 'clientCreditReference', 'lineItems',
      'subtotal', 'gstTotal', 'grossTotal', 'retentionAmount', 'retentionGst', 'retentionTotal', 'receivableTotal',
    ],
  },
  retentionRelease: {
    docType:   CRR_DOC_TYPE,
    numberKey: 'releaseNumber',
    numberPattern: /^CRR-\d{4,}$/,
    dateKey:   'releaseDate',
    text: { notes: CLIENT_ENTRY_LIMITS.NOTES },
    keys: [...COMMON_KEYS, 'releaseNumber', 'releaseDate', 'amount', 'gstAmount', 'releaseTotal'],
  },
}

const sameKeys = (object, keys) => {
  const own = Object.keys(object)
  return own.length === keys.length && keys.every(key => own.includes(key))
}

const boundedText = (value, max) => typeof value === 'string' && value.length <= max

// The free text of a draft as the editor hands it over: an error message, or
// null. Called before a draft is written, so a bound is met at save and never
// first discovered at posting.
export function clientEntryTextError(shape, input) {
  if (String(input?.reason || '').trim().length > CLIENT_ENTRY_LIMITS.REASON) {
    return `The reason cannot be longer than ${CLIENT_ENTRY_LIMITS.REASON} characters.`
  }
  for (const [key, max] of Object.entries(shape.text)) {
    if (String(input?.[key] || '').trim().length > max) {
      return `${key === 'notes' ? 'The notes' : 'The reference'} cannot be longer than ${max} characters.`
    }
  }
  return null
}

// The FIRST field on which a stored DRAFT is not the shape above, or null.
// `invoice` — the target, `{ id, …data }` — supplies the snapshots the draft
// must repeat. Figures and line contents are not judged here.
export function clientEntryDraftProblem(shape, entry, invoice) {
  if (entry === null || typeof entry !== 'object') return 'entry'
  const extra = Object.keys(entry).find(key => key !== 'id' && !shape.keys.includes(key))
  if (extra) return extra
  const missing = shape.keys.find(key => !(key in entry))
  if (missing) return missing

  if (entry.status !== CCN_STATUS.DRAFT) return 'status'
  if (entry.docType !== shape.docType) return 'docType'
  if (typeof entry[shape.numberKey] !== 'string' || !shape.numberPattern.test(entry[shape.numberKey])) return shape.numberKey
  if (!isIsoDateShape(entry[shape.dateKey])) return shape.dateKey
  if (typeof entry.reason !== 'string' || entry.reason.trim().length === 0 || entry.reason.length > CLIENT_ENTRY_LIMITS.REASON) return 'reason'
  for (const [key, max] of Object.entries(shape.text)) {
    if (!boundedText(entry[key], max)) return key
  }
  if (typeof entry.revision !== 'number' || !Number.isFinite(entry.revision)) return 'revision'
  if (!Number.isInteger(entry.ledgerSeq) || entry.ledgerSeq < 0) return 'ledgerSeq'

  const pristine = pristineLifecycle()
  const touched = Object.keys(pristine).find(key => entry[key] !== pristine[key])
  if (touched) return touched

  const snapshot = invoiceSnapshot(invoice)
  const drifted = Object.keys(snapshot).find(key => entry[key] !== snapshot[key])
  if (drifted) return drifted
  if (typeof entry.currency !== 'string' || entry.currency !== invoice.currency) return 'currency'

  if ('lineItems' in entry) {
    const lines = entry.lineItems
    if (!Array.isArray(lines) || lines.length === 0 || lines.length > CLIENT_ENTRY_LIMITS.LINES) return 'lineItems'
    const bad = lines.findIndex(li => li === null || typeof li !== 'object' || Array.isArray(li) || !sameKeys(li, CLIENT_CREDIT_LINE_KEYS))
    if (bad >= 0) return `lineItems[${bad}]`
  }
  return null
}

// ── Client receipts ──────────────────────────────────────────────────────────
//
// A client receipt is posted by the trusted backend too (ADR-89), under the
// same rule: the draft must be EXACTLY the document the app writes
// (hooks/useClientReceipts.jsx → createClientReceipt). Receipts pre-date this
// module and have carried this key set since they were introduced.

export const CLIENT_RECEIPT_LIMITS = {
  REFERENCE:   200,
  METHOD:      40,     // the Rules' own bound on `paymentMethod`
  NOTES:       CLIENT_ENTRY_LIMITS.NOTES,
  NAME:        300,
  ALLOCATIONS: MAX_ALLOCATIONS,
}

export const CLIENT_RECEIPT_NUMBER_PATTERN = /^CR-\d{4,}$/

// EXACTLY the keys a draft receipt carries.
export const CLIENT_RECEIPT_KEYS = [
  'receiptNumber', 'status', 'docType', 'clientId', 'clientName', 'receiptDate', 'amount',
  'paymentMethod', 'paymentMethodOther', 'bankReference', 'externalReference',
  'allocations', 'allocatedTotal', 'unallocatedAmount', 'currency', 'revision', 'notes',
  'postedAt', 'postedBy', 'voidedAt', 'voidedBy', 'voidReason',
  'attachments', 'externalRefs',
  'createdAt', 'createdBy', 'updatedAt', 'updatedBy',
]

// EXACTLY the keys each embedded allocation carries.
export const CLIENT_RECEIPT_ALLOCATION_KEYS = ['clientInvoiceId', 'invoiceNumber', 'allocatedAmount']

// Free text a receipt carries beyond its client name, with its bound.
const RECEIPT_TEXT = {
  paymentMethodOther: CLIENT_RECEIPT_LIMITS.REFERENCE,
  bankReference:      CLIENT_RECEIPT_LIMITS.REFERENCE,
  externalReference:  CLIENT_RECEIPT_LIMITS.REFERENCE,
  notes:              CLIENT_RECEIPT_LIMITS.NOTES,
}

const isEmptyObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0

// The free text of a receipt as the editor hands it over: an error message, or
// null — so a bound is met at save and never first discovered at posting.
export function clientReceiptTextError(input) {
  const labels = { paymentMethodOther: 'The payment method description', bankReference: 'The bank reference', externalReference: 'The external reference', notes: 'The notes' }
  for (const [key, max] of Object.entries(RECEIPT_TEXT)) {
    if (String(input?.[key] || '').trim().length > max) return `${labels[key]} cannot be longer than ${max} characters.`
  }
  return null
}

// The FIRST field on which a stored DRAFT receipt is not the document the app
// writes, or null. Whether its figures add up, and whether each allocation
// names an invoice that can take it, are judged separately
// (lib/clientReceiptPosting.js and the backend's own reads).
export function clientReceiptDraftProblem(receipt) {
  if (receipt === null || typeof receipt !== 'object') return 'receipt'
  const extra = Object.keys(receipt).find(key => key !== 'id' && !CLIENT_RECEIPT_KEYS.includes(key))
  if (extra) return extra
  const missing = CLIENT_RECEIPT_KEYS.find(key => !(key in receipt))
  if (missing) return missing

  if (receipt.status !== PAYMENT_STATUS.DRAFT) return 'status'
  if (receipt.docType !== CR_DOC_TYPE.RECEIPT) return 'docType'
  if (typeof receipt.receiptNumber !== 'string' || !CLIENT_RECEIPT_NUMBER_PATTERN.test(receipt.receiptNumber)) return 'receiptNumber'
  if (typeof receipt.clientId !== 'string' || receipt.clientId.length === 0) return 'clientId'
  if (typeof receipt.clientName !== 'string' || receipt.clientName.trim().length === 0 || receipt.clientName.length > CLIENT_RECEIPT_LIMITS.NAME) return 'clientName'
  if (!isIsoDateShape(receipt.receiptDate)) return 'receiptDate'
  if (!isPaymentMethod(receipt.paymentMethod)) return 'paymentMethod'
  for (const [key, max] of Object.entries(RECEIPT_TEXT)) {
    if (!boundedText(receipt[key], max)) return key
  }
  if (typeof receipt.currency !== 'string' || !/^[A-Z]{3}$/.test(receipt.currency)) return 'currency'
  if (typeof receipt.revision !== 'number' || !Number.isFinite(receipt.revision)) return 'revision'

  const pristine = pristineLifecycle()
  const touched = Object.keys(pristine).find(key => receipt[key] !== pristine[key])
  if (touched) return touched

  // Reserved fields: the app writes them empty, and nothing reads them yet.
  if (!Array.isArray(receipt.attachments) || receipt.attachments.length !== 0) return 'attachments'
  if (!isEmptyObject(receipt.externalRefs)) return 'externalRefs'

  const allocations = receipt.allocations
  if (!Array.isArray(allocations) || allocations.length > CLIENT_RECEIPT_LIMITS.ALLOCATIONS) return 'allocations'
  const seen = new Set()
  for (const [i, a] of allocations.entries()) {
    if (a === null || typeof a !== 'object' || Array.isArray(a) || !sameKeys(a, CLIENT_RECEIPT_ALLOCATION_KEYS)) return `allocations[${i}]`
    if (typeof a.clientInvoiceId !== 'string' || a.clientInvoiceId.length === 0) return `allocations[${i}].clientInvoiceId`
    if (seen.has(a.clientInvoiceId)) return `allocations[${i}].clientInvoiceId`   // one invoice, one allocation
    seen.add(a.clientInvoiceId)
    if (typeof a.invoiceNumber !== 'string') return `allocations[${i}].invoiceNumber`
    if (typeof a.allocatedAmount !== 'number') return `allocations[${i}].allocatedAmount`
  }
  return null
}
