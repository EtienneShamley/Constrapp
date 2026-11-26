import { toCents, fromCents } from './money'
import { isIsoDateShape } from './payments'
import { CI_STATUS, TAX_CODES, invoiceRetention } from './clientInvoices'
import { allocateCredit, creditNoteCents, readLedger } from './clientLedger'

// ── Client Credit Notes (accounts receivable — reduction facts) ──────────────
//
// A Client Credit Note records a REDUCTION against ONE issued Client Invoice:
// an over-billed amount, a billing error, a withdrawn charge. It is the third
// document kind on the receivable side (ADR-87):
//
//   · client invoice     — what was BILLED
//   · client receipt     — the CASH fact
//   · client credit note — the REDUCTION-of-billing fact
//
// ⚠️ AN INVOICE CORRECTION, NOT A CONTRACT ADJUSTMENT. A credit note reduces
// what has been BILLED: net Issued falls and Available to Invoice rises by the
// same ex-GST amount, so the corrected value can be billed again. It never
// changes the Current Contract Sum, Forecast Revenue or Margin — a reduction in
// what the client owes for the JOB is a negative approved client variation,
// which already reduces the contract sum, and a credit note must never subtract
// it a second time.
//
// ⚠️ NOT CASH. No receipt is created, changed or reversed. A credit that takes
// an invoice below what has been received leaves a balance OWED TO THE CLIENT,
// shown as such — never clamped to zero, and never turned into a refund record
// Constrap does not have.
//
// ⚠️ NOTHING IS WRITTEN ONTO THE INVOICE. Net figures are derived at read time
// (lib/clientReceivables.js); voiding a credit restores them with no reversal
// document. A credit note is POSTED, and a posted one VOIDED, only by the
// trusted backend (ADR-89): it re-derives every line and total with
// buildClientCreditNote below, refuses a draft that differs, and enforces the
// cumulative cap through the per-invoice ledger (lib/clientLedger.js).

export const CCN_STATUS = { DRAFT: 'draft', POSTED: 'posted', VOID: 'void' }

export const CCN_STATUS_LABELS = {
  [CCN_STATUS.DRAFT]:  'Draft',
  [CCN_STATUS.POSTED]: 'Posted',
  [CCN_STATUS.VOID]:   'Void',
}

// Existing Badge variants — no new colours.
export const CCN_BADGE_VARIANTS = {
  [CCN_STATUS.DRAFT]:  'soon',
  [CCN_STATUS.POSTED]: 'active',
  [CCN_STATUS.VOID]:   'danger',
}

// Forward-only; void is terminal. Rules let a client draft and void a draft;
// posting and voiding a posted note are the trusted backend's.
export const CCN_TRANSITIONS = {
  [CCN_STATUS.DRAFT]:  [CCN_STATUS.POSTED, CCN_STATUS.VOID],
  [CCN_STATUS.POSTED]: [CCN_STATUS.VOID],
  [CCN_STATUS.VOID]:   [],
}

export const canTransition = (from, to) => (CCN_TRANSITIONS[from] ?? []).includes(to)

export const CCN_DOC_TYPE = 'credit_note'
export const CLIENT_CREDIT_NOTE_COUNTER_ID = 'clientCreditNotes'
export const formatClientCreditNoteNumber = (n) => `CCN-${String(n).padStart(4, '0')}`

// Bounds the embedded line array; checked by Rules on a draft and by the
// backend at posting.
export const MAX_CLIENT_CREDIT_LINES = 100

export const postedClientCreditNotes = (creditNotes) =>
  (creditNotes ?? []).filter(cn => cn?.status === CCN_STATUS.POSTED)

export const draftClientCreditNotes = (creditNotes) =>
  (creditNotes ?? []).filter(cn => cn?.status === CCN_STATUS.DRAFT)

// ── Eligible targets ─────────────────────────────────────────────────────────
// Only an ISSUED client invoice can be credited: a draft has billed nothing and
// a void invoice is nothing. Checked by Rules on a draft and by the backend at
// posting.
export const isCreditableClientInvoice = (invoice) =>
  invoice?.status === CI_STATUS.ISSUED
  && typeof invoice.currency === 'string' && invoice.currency.length > 0

// ── Building a credit note from editor rows ──────────────────────────────────
//
// `rows` — [{ invoiceLineIndex, amount }]. Each credit line copies its SOURCE
// line's description, tax code, variation and cost-code snapshots: a credit
// cannot change how the invoice line was taxed or attributed.
//
// Returns { error } or { lineItems, totals } ready to store. `ledgerDoc` is the
// invoice's CURRENT ledger document (null when none exists).
export function buildClientCreditNote(invoice, ledgerDoc, rows) {
  const ledgerState = readLedger(ledgerDoc)
  const allocation = allocateCredit(invoice, ledgerState, rows)
  if (allocation.error) return { error: allocation.error }

  const lineItems = allocation.lines.map((line) => {
    const source = invoice.lineItems[line.invoiceLineIndex]
    return {
      invoiceLineIndex: line.invoiceLineIndex,
      description:      String(source?.description || '').trim(),
      amount:           fromCents(line.amountCents),
      taxCode:          source?.taxCode ?? null,
      gstAmount:        fromCents(line.gstCents),
      variationId:      source?.variationId ?? null,
      variationNumber:  source?.variationNumber ?? '',
      costCodeId:       source?.costCodeId ?? null,
      costCodeName:     source?.costCodeName ?? null,
    }
  })

  const grossCents = allocation.subtotalCents + allocation.gstCents
  const retentionTotalCents = allocation.retentionCents + allocation.retentionGstCents
  return {
    lineItems,
    ledgerSeq: ledgerState.seq,
    totals: {
      subtotal:        fromCents(allocation.subtotalCents),
      gstTotal:        fromCents(allocation.gstCents),
      grossTotal:      fromCents(grossCents),
      // The part of this credit that reduces retention STILL HELD, and the rest,
      // which reduces what is receivable now. Stored, never recomputed.
      retentionAmount: fromCents(allocation.retentionCents),
      retentionGst:    fromCents(allocation.retentionGstCents),
      retentionTotal:  fromCents(retentionTotalCents),
      receivableTotal: fromCents(grossCents - retentionTotalCents),
    },
  }
}

// ── Read-time validity gate ──────────────────────────────────────────────────
//
// A POSTED credit note counts toward a figure ONLY when this returns null.
// DEFENCE IN DEPTH since ADR-89: the trusted backend re-derives every line and
// total before it posts, so a posted note that fails here cannot come from the
// app — it would mean a document altered outside it (or a note posted before a
// later integrity problem with its invoice). Every fact below IS determinable
// at read time. A failing document is
// excluded WHOLE and listed as an exception; nothing is clamped.
//
// The safe direction on the receivable side is to keep the DEBT visible: an
// uncounted credit leaves Issued and the receivable as the invoice states them.
export function clientCreditException(creditNote, invoiceById) {
  const invoice = invoiceById?.get?.(creditNote?.clientInvoiceId) ?? null
  if (!invoice) return 'The credited client invoice no longer exists or is not readable.'
  if (invoice.status !== CI_STATUS.ISSUED) {
    return `${invoice.invoiceNumber} is ${invoice.status} — a credit note only counts against an issued client invoice.`
  }
  if ((invoice.clientId ?? null) !== (creditNote.clientId ?? null)) {
    return `${invoice.invoiceNumber} belongs to a different client than this credit note.`
  }
  if (invoice.currency !== creditNote.currency) {
    return `${invoice.invoiceNumber} is denominated in ${invoice.currency || 'an unknown currency'}, not ${creditNote.currency || 'unknown'}.`
  }

  const lines = creditNote?.lineItems
  if (!Array.isArray(lines) || lines.length === 0) {
    return 'The credit note carries no readable line items, so its stored totals cannot be verified.'
  }
  const sourceLines = Array.isArray(invoice.lineItems) ? invoice.lineItems : []
  const seen = new Set()
  let subtotalCents = 0
  let gstCents = 0
  for (let i = 0; i < lines.length; i += 1) {
    const li = lines[i]
    const source = sourceLines[li?.invoiceLineIndex]
    if (!Number.isInteger(li?.invoiceLineIndex) || !source) {
      return `Line ${i + 1} does not name a line of ${invoice.invoiceNumber}.`
    }
    if (seen.has(li.invoiceLineIndex)) return `Line ${i + 1} credits an invoice line twice.`
    seen.add(li.invoiceLineIndex)
    const amountCents = toCents(li.amount)
    const lineGstCents = toCents(li.gstAmount)
    if (!(amountCents > 0)) return `Line ${i + 1} does not carry a positive ex-GST amount.`
    if (amountCents > toCents(source.amount)) {
      return `Line ${i + 1} credits more than the invoice line it names.`
    }
    if (!TAX_CODES.includes(li.taxCode) || li.taxCode !== source.taxCode) {
      return `Line ${i + 1}'s tax code does not match the invoice line it credits.`
    }
    if (lineGstCents < 0 || lineGstCents > toCents(source.gstAmount)) {
      return `Line ${i + 1}'s GST is not within the GST of the invoice line it credits.`
    }
    if ((li.variationId ?? null) !== (source.variationId ?? null)) {
      return `Line ${i + 1} names a different variation than the invoice line it credits.`
    }
    subtotalCents += amountCents
    gstCents += lineGstCents
  }

  const stored = creditNoteCents(creditNote)
  if (stored.subtotalCents !== subtotalCents || stored.gstCents !== gstCents
    || toCents(creditNote.grossTotal) !== subtotalCents + gstCents) {
    return 'The stored totals do not reconcile to the credit note\'s own line items.'
  }
  const inv = invoiceRetention(invoice)
  if (stored.subtotalCents > inv.subtotalCents || stored.gstCents > inv.gstCents) {
    return `The credit note exceeds ${invoice.invoiceNumber}.`
  }
  if (stored.retentionCents < 0 || stored.retentionGstCents < 0
    || stored.retentionCents > Math.min(stored.subtotalCents, inv.retentionCents)
    || stored.retentionGstCents > inv.retentionGstCents) {
    return 'The retention part of this credit note is not within the credit or the retention withheld.'
  }
  return null
}

export const invoicesById = (invoices) => new Map((invoices ?? []).map(inv => [inv.id, inv]))

export const countingClientCreditNotes = (creditNotes, invoices) => {
  const byId = invoicesById(invoices)
  return postedClientCreditNotes(creditNotes).filter(cn => clientCreditException(cn, byId) === null)
}

export function clientCreditExceptions(creditNotes, invoices) {
  const byId = invoicesById(invoices)
  const out = []
  for (const cn of postedClientCreditNotes(creditNotes)) {
    const reason = clientCreditException(cn, byId)
    if (!reason) continue
    out.push({
      creditNoteId: cn.id,
      creditNumber: cn.creditNumber,
      invoiceNumber: cn.invoiceNumber || '—',
      grossTotal: fromCents(toCents(cn.grossTotal)),
      reason,
    })
  }
  return out
}

export const CLIENT_CREDIT_EXCEPTION_REMEDY =
  'A credit note listed here failed a read-time integrity check. It reduces no figure, so the amount billed and ' +
  'the amount receivable stay as the invoice states them — the safe failure. Nothing is clamped or reversed ' +
  'automatically. Investigate first; where the credit note itself is wrong, void it and record a new one.'

// { variationId: Σ ex-GST credited } across counting credit notes.
export function creditedByVariation(creditNotes, invoices) {
  const map = {}
  for (const cn of countingClientCreditNotes(creditNotes, invoices)) {
    for (const li of cn.lineItems ?? []) {
      if (!li.variationId) continue
      map[li.variationId] = (map[li.variationId] || 0) + toCents(li.amount)
    }
  }
  return Object.fromEntries(Object.entries(map).map(([k, v]) => [k, fromCents(v)]))
}

export function creditNotesForInvoice(creditNotes, clientInvoiceId) {
  return (creditNotes ?? [])
    .filter(cn => cn.clientInvoiceId === clientInvoiceId)
    .sort((a, b) => (b.creditNumber || '').localeCompare(a.creditNumber || ''))
}

export function clientCreditSummary(creditNotes, invoices) {
  const byId = invoicesById(invoices)
  let postedGross = 0, postedCount = 0, exceptionGross = 0, exceptionCount = 0, draftGross = 0
  for (const cn of postedClientCreditNotes(creditNotes)) {
    if (clientCreditException(cn, byId) === null) { postedGross += toCents(cn.grossTotal); postedCount += 1 }
    else { exceptionGross += toCents(cn.grossTotal); exceptionCount += 1 }
  }
  const drafts = draftClientCreditNotes(creditNotes)
  for (const cn of drafts) draftGross += toCents(cn.grossTotal)
  return {
    postedCount, postedGross: fromCents(postedGross),
    exceptionCount, exceptionGross: fromCents(exceptionGross),
    draftCount: drafts.length, draftGross: fromCents(draftGross),
  }
}

// ── Validation (client-side preview; the trusted backend is the boundary) ────
export function validateClientCreditDraft({ clientInvoiceId, creditDate, reason, rows }, { invoice = null, ledgerDoc = null } = {}) {
  if (!clientInvoiceId) return 'Select the issued client invoice this credit note adjusts.'
  if (invoice && invoice.id !== clientInvoiceId) return 'The supplied invoice does not match the selected target.'
  if (invoice && !isCreditableClientInvoice(invoice)) {
    return invoice.status === CI_STATUS.ISSUED
      ? `${invoice.invoiceNumber} stores no currency, so it cannot be credited.`
      : `${invoice.invoiceNumber} is ${invoice.status} — only an issued client invoice can be credited.`
  }
  if (!isIsoDateShape(creditDate)) return 'Enter the credit note date.'
  if (!String(reason || '').trim()) return 'Enter the reason this credit is being issued.'
  if ((rows ?? []).length > MAX_CLIENT_CREDIT_LINES) {
    return `A credit note cannot carry more than ${MAX_CLIENT_CREDIT_LINES} lines.`
  }
  if (invoice) {
    const built = buildClientCreditNote(invoice, ledgerDoc, rows)
    if (built.error) return built.error
  }
  return null
}

// Why a draft cannot be posted, or null — the browser's PREVIEW of the server's
// decision. `ledgerDoc` must be the CURRENT ledger of the target. A draft whose
// stored figures no longer equal what would be derived now is refused rather
// than silently recalculated: the user posts what was reviewed.
export function clientCreditPostBlockedReason(creditNote, invoice, ledgerDoc) {
  if (!creditNote) return 'Credit note not found.'
  if (creditNote.status !== CCN_STATUS.DRAFT) {
    return `Only a draft credit note can be posted — this one is ${creditNote.status}.`
  }
  if (!invoice) return 'The credited client invoice could not be found on this project.'
  if (!isCreditableClientInvoice(invoice)) {
    return invoice.status === CI_STATUS.ISSUED
      ? `${invoice.invoiceNumber} stores no currency, so it cannot be credited.`
      : `${invoice.invoiceNumber} is ${invoice.status} — only an issued client invoice can be credited.`
  }
  // Stale means the FIGURES would differ — exactly what the server checks. The
  // ledger sequence alone proves nothing: a receipt steps it without changing
  // what this credit note would be.
  const rebuilt = buildClientCreditNote(invoice, ledgerDoc,
    (creditNote.lineItems ?? []).map(li => ({ invoiceLineIndex: li.invoiceLineIndex, amount: li.amount })))
  if (rebuilt.error) return rebuilt.error
  const stored = creditNoteCents(creditNote)
  if (toCents(rebuilt.totals.subtotal) !== stored.subtotalCents
    || toCents(rebuilt.totals.gstTotal) !== stored.gstCents
    || toCents(rebuilt.totals.retentionAmount) !== stored.retentionCents
    || toCents(rebuilt.totals.retentionGst) !== stored.retentionGstCents) {
    return CLIENT_ENTRY_STALE_TEXT
  }
  return null
}

export const CLIENT_ENTRY_STALE_TEXT =
  'Another credit note or retention release has been posted or voided on this invoice since this draft was ' +
  'prepared. Re-open and save the draft to refresh its figures, then post it.'

// A failed read of credit notes is UNKNOWN, never zero: net Issued, Available
// to Invoice and every receivable depend on them.
export const CLIENT_CREDIT_READ_UNAVAILABLE_NOTICE =
  'Client Credit Notes could not be loaded. Posted credit notes reduce the amount billed and the amount ' +
  'receivable, so every figure that depends on them is shown as Unavailable rather than as though no credits ' +
  'exist — reload the page, and check your connection and permissions if this persists.'

export const CLIENT_CREDIT_NOTE_NOTICE =
  'A credit note reduces what has been billed on one issued invoice. It does not change the contract sum and it ' +
  'moves no cash. Posting is done by the Constrap server, which re-derives every line and total from the invoice, ' +
  'refuses a credit note that differs, and caps the total credited against an invoice through the invoice\'s ' +
  'ledger. Each posted credit is checked again when it is read: one that fails counts nothing and is listed as ' +
  'an exception.'
