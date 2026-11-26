// ── The client-finance domain, as the trusted backend runs it (ADR-89) ───────
//
// The ENTRY MODULE of functions/src/generated/clientFinanceCalc.js
// (scripts/build-client-finance-bundle.mjs). It defines nothing: it re-exports,
// from the modules the browser previews and drafts with, exactly what the four
// posting callables compose — so a credit note or retention release is
// derived, checked and applied to the ledger by ONE set of formulas, and judged
// against ONE description of a draft (lib/clientEntryShape.js), in both places.
//
// Add a name here only when functions/src/clientFinance/ needs it. A formula
// never belongs in this file, and never in functions/src.

export { toCents, fromCents, isWholeCents, MAX_SUPPORTED_AMOUNT_CENTS, MAX_SUPPORTED_RECEIPT_CENTS } from './money'
export { PAYMENT_STATUS } from './payments'
export { CI_STATUS, invoiceTotals, invoiceRetention } from './clientInvoices'
export {
  LEDGER_KIND, LEDGER_TOTAL_KEYS, readLedger, ledgerDocument, ledgerInvariantError, ledgerPosition,
  storedLedgerProblem, ledgerStateProblem,
  applyCredit, applyCreditVoid, applyRelease, applyReleaseVoid, applyReceipt, applyReceiptVoid,
} from './clientLedger'
export { CCN_STATUS, CCN_DOC_TYPE, buildClientCreditNote } from './clientCreditNotes'
export { CRR_STATUS, CRR_DOC_TYPE, buildClientRetentionRelease } from './clientRetention'
export {
  CLIENT_ENTRY_SHAPES, CLIENT_CREDIT_LINE_KEYS, CLIENT_RECEIPT_KEYS, CLIENT_RECEIPT_ALLOCATION_KEYS,
  clientEntryDraftProblem, clientReceiptDraftProblem, clientFinanceActivated,
} from './clientEntryShape'
export {
  latestPostableReceiptDate, deriveReceiptTotals, storedReceiptAllocations, postedReceiptAllocations, allocatedInvoiceIds,
  receiptBaselineSums, unlistedReceivedCents,
  receiptOverAllocations,
} from './clientReceiptPosting'
