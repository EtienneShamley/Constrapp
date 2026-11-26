// ── Client credit notes and retention releases — shared test fixture ─────────
//
// Plain documents for the reporting suites (Commercial Report, Portfolio, Final
// Account). Every credit note and release is BUILT by the app's own builders
// (lib/clientCreditNotes.js, lib/clientRetention.js) against the invoice it
// targets, so each one passes the read-time validity gate by construction and
// no suite hand-writes a header that could drift from the allocation rules.

import { invoiceTotals } from '../../src/lib/clientInvoices'
import { buildClientCreditNote } from '../../src/lib/clientCreditNotes'
import { buildClientRetentionRelease } from '../../src/lib/clientRetention'
import { allocationTotals } from '../../src/lib/payments'

// An ISSUED client invoice of one GST line: `subtotal` ex-GST, 10% GST, and
// `retention` (ex-GST) withheld by the client.
export function issuedInvoice({ id = 'ci1', invoiceNumber = 'CI-0001', subtotal = 9000, retention = 0, ...over } = {}) {
  const lineItems = [{ description: 'Progress to date', amount: subtotal, taxCode: 'gst', gstAmount: subtotal / 10, variationId: null }]
  return {
    id, invoiceNumber, status: 'issued', clientId: 'c1', clientName: 'Owner Pty Ltd', currency: 'AUD',
    invoiceDate: '2026-09-01', dueDate: '2026-10-01', lineItems, ...invoiceTotals(lineItems, retention), ...over,
  }
}

// A POSTED credit note of `amount` (ex-GST) against the invoice's first line.
export function creditNoteFor(invoice, amount, over = {}) {
  const built = buildClientCreditNote(invoice, null, [{ invoiceLineIndex: 0, amount }])
  if (built.error) throw new Error(built.error)
  return {
    id: 'ccn1', creditNumber: 'CCN-0001', status: 'posted', clientInvoiceId: invoice.id, invoiceNumber: invoice.invoiceNumber,
    clientId: invoice.clientId, clientName: invoice.clientName, currency: invoice.currency, creditDate: '2026-10-15',
    reason: 'Over-billed', lineItems: built.lineItems, ...built.totals, ...over,
  }
}

// A POSTED release of `amount` (ex-GST) of the retention the invoice withheld.
export function releaseFor(invoice, amount, over = {}) {
  const built = buildClientRetentionRelease(invoice, null, amount)
  if (built.error) throw new Error(built.error)
  return {
    id: 'crr1', releaseNumber: 'CRR-0001', status: 'posted', clientInvoiceId: invoice.id, invoiceNumber: invoice.invoiceNumber,
    clientId: invoice.clientId, currency: invoice.currency, releaseDate: '2026-10-20', reason: 'Practical completion',
    amount: built.amount, gstAmount: built.gstAmount, releaseTotal: built.releaseTotal, ...over,
  }
}

// A DRAFT client receipt, key for key what hooks/useClientReceipts.jsx →
// createClientReceipt stores (the stamps are the caller's: they are server
// timestamps). `allocations` — [{ clientInvoiceId, invoiceNumber, allocatedAmount }].
export function draftReceipt({ receiptNumber = 'CR-0001', amount, allocations = [], ...over } = {}) {
  const allocated = allocationTotals(amount, allocations)
  return {
    receiptNumber, status: 'draft', docType: 'receipt',
    clientId: 'c1', clientName: 'Owner Pty Ltd', receiptDate: '2026-11-20', amount,
    paymentMethod: 'bank_transfer', paymentMethodOther: '', bankReference: 'REF-1', externalReference: '',
    allocations, allocatedTotal: allocated.allocatedTotal, unallocatedAmount: allocated.unallocatedAmount,
    currency: 'AUD', revision: 1, notes: '',
    postedAt: null, postedBy: null, voidedAt: null, voidedBy: null, voidReason: '',
    attachments: [], externalRefs: {},
    ...over,
  }
}
