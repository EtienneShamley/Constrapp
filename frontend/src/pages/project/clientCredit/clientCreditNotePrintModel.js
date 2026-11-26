import { CCN_STATUS, CCN_STATUS_LABELS } from '../../../lib/clientCreditNotes'
import { TAX_CODE_LABELS } from '../../../lib/clientInvoices'

// ── Printed Client Credit Note — the text / row model ────────────────────────
//
// PURE: no React, no hook, no read, no write, no clock. It turns ONE stored
// credit note (and the invoice it corrects, for the invoice date) into the
// labels and rows the print component lays out.
//
// ⚠️ NO ARITHMETIC. Every amount below is a field read from the stored credit
// note exactly as it was written — subtotal, GST, total and the retention
// split are never re-added, re-derived or rounded here. Amounts and dates are
// returned RAW; the component formats them through the existing formatters.
//
// What the document is, and is not: a record of a credit against one client
// invoice, produced from Constrap. It is not a tax document, and the model
// never names it as one (see CLIENT_CREDIT_NOTE_PRINT_DISCLAIMER).

export const CLIENT_CREDIT_NOTE_PRINT_TITLE = 'Credit Note'

export const CLIENT_CREDIT_NOTE_PRINT_DISCLAIMER =
  'This is a record produced from Constrap of a credit against the client invoice named above. It is not a tax ' +
  'document and does not replace the credit documentation issued to the client from your accounting system.'

// Said in WORDS on the document — a draft or a void credit note must never be
// mistaken for a posted one, on a greyscale printer as much as on screen.
export const CLIENT_CREDIT_NOTE_STATUS_NOTICE = {
  [CCN_STATUS.DRAFT]:
    'DRAFT — NOT POSTED. This credit note has not been applied to the invoice and changes no figure.',
  [CCN_STATUS.VOID]:
    'VOID. This credit note has been voided. It credits nothing and is kept as history only.',
}

export const POSTED_BY_UNRECORDED = 'Name not recorded on this credit note'

const text = (v) => (typeof v === 'string' ? v.trim() : '')
const amount = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)

// `people` — an optional { uid: display name } map the page may supply; the
// credit note itself stores only the uid of who posted or voided it.
const personName = (storedName, uid, people) => text(storedName) || text(people?.[uid]) || null

export function buildClientCreditNotePrint({ creditNote, invoice = null, projectName = '', people = null } = {}) {
  if (!creditNote) return null
  const status = creditNote.status
  const isPosted = status === CCN_STATUS.POSTED
  const isVoid = status === CCN_STATUS.VOID
  // A credit note voided AFTER it was posted still carries its posted stamp.
  const wasPosted = isPosted || (isVoid && (creditNote.postedAt != null || creditNote.postedBy != null))

  const retentionTotal = amount(creditNote.retentionTotal)

  return {
    title: CLIENT_CREDIT_NOTE_PRINT_TITLE,
    number: text(creditNote.creditNumber),
    projectName: text(projectName),
    currencyCode: text(creditNote.currency) || null,

    status,
    statusLabel: CCN_STATUS_LABELS[status] ?? text(status),
    statusNotice: CLIENT_CREDIT_NOTE_STATUS_NOTICE[status] ?? null,

    creditDate: text(creditNote.creditDate) || null,
    clientName: text(creditNote.clientName) || null,
    invoice: {
      number: text(creditNote.invoiceNumber) || text(invoice?.invoiceNumber) || null,
      // The invoice date is not snapshotted on the credit note; it is read from
      // the invoice when the page has it, and is absent otherwise.
      date: text(invoice?.invoiceDate) || null,
    },
    reason: text(creditNote.reason) || null,
    externalReference: text(creditNote.clientCreditReference) || null,

    lines: (creditNote.lineItems ?? []).map((li, i) => ({
      key: i,
      description: text(li?.description) || `Line ${i + 1}`,
      variationNumber: text(li?.variationNumber) || null,
      taxLabel: TAX_CODE_LABELS[li?.taxCode] ?? (text(li?.taxCode) || '—'),
      amount: amount(li?.amount),
      gstAmount: amount(li?.gstAmount),
    })),

    totals: [
      { key: 'subtotal',   label: 'Subtotal (ex-GST)',       amount: amount(creditNote.subtotal) },
      { key: 'gstTotal',   label: 'GST reversed',            amount: amount(creditNote.gstTotal) },
      { key: 'grossTotal', label: 'Credit total (inc. GST)', amount: amount(creditNote.grossTotal), strong: true },
    ],

    // Shown only when this credit actually took retention still held.
    retentionSplit: retentionTotal !== null && retentionTotal > 0
      ? [
          { key: 'retentionTotal',  label: 'Reduces retention held',    amount: retentionTotal },
          { key: 'receivableTotal', label: 'Reduces amount receivable', amount: amount(creditNote.receivableTotal) },
        ]
      : null,

    posted: wasPosted
      ? { byName: personName(creditNote.postedByName, creditNote.postedBy, people), at: creditNote.postedAt ?? null }
      : null,
    voided: isVoid
      ? {
          reason: text(creditNote.voidReason) || null,
          byName: personName(creditNote.voidedByName, creditNote.voidedBy, people),
          at: creditNote.voidedAt ?? null,
        }
      : null,

    disclaimer: CLIENT_CREDIT_NOTE_PRINT_DISCLAIMER,
  }
}
