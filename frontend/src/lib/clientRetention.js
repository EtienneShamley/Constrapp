import { toCents, fromCents } from './money'
import { isIsoDateShape } from './payments'
import { CI_STATUS, hasRetention } from './clientInvoices'
import { allocateRelease, readLedger } from './clientLedger'
import { CLIENT_ENTRY_STALE_TEXT } from './clientCreditNotes'

// ── Client Retention Release (ADR-88) ────────────────────────────────────────
//
// Client retention is withheld ON THE CLIENT INVOICE (`retention`,
// `retentionGst`, `retentionTotal` — lib/clientInvoices.js) and is not
// receivable on that invoice until it is released.
//
// A CLIENT RETENTION RELEASE is the authored commercial event that makes part
// or all of that withheld retention RECEIVABLE.
//
// ⚠️ IT IS NOT AN INVOICE, NOT A CREDIT NOTE AND NOT A RECEIPT. It bills
// nothing new (the retained value was billed, and counted as issued, when the
// invoice was issued), reduces nothing, and moves no cash — only a posted
// Client Receipt does. Withheld retention was never a reduction in billed or
// earned value.
//
// ⚠️ NOTHING IS WRITTEN ONTO THE INVOICE. Held and released are derived at read
// time; voiding a release restores every balance with no reversal document.
// A release is POSTED, and a posted release VOIDED, only by the trusted backend
// (ADR-89), which re-derives its GST, enforces the cumulative cap through the
// per-invoice ledger (lib/clientLedger.js) and refuses a void that receipts
// already rely on.
//
// ⚠️ RETENTION *RECEIVED* IS NOT REPORTED. A receipt allocation settles an
// invoice balance as ONE balance; nothing identifies which band of it the
// money settled (the ADR-30 reasoning).

export const CRR_STATUS = { DRAFT: 'draft', POSTED: 'posted', VOID: 'void' }

export const CRR_STATUS_LABELS = {
  [CRR_STATUS.DRAFT]:  'Draft',
  [CRR_STATUS.POSTED]: 'Posted',
  [CRR_STATUS.VOID]:   'Void',
}

export const CRR_BADGE_VARIANTS = {
  [CRR_STATUS.DRAFT]:  'soon',
  [CRR_STATUS.POSTED]: 'active',
  [CRR_STATUS.VOID]:   'danger',
}

export const CRR_TRANSITIONS = {
  [CRR_STATUS.DRAFT]:  [CRR_STATUS.POSTED, CRR_STATUS.VOID],
  [CRR_STATUS.POSTED]: [CRR_STATUS.VOID],
  [CRR_STATUS.VOID]:   [],
}

export const canTransition = (from, to) => (CRR_TRANSITIONS[from] ?? []).includes(to)

export const CRR_DOC_TYPE = 'client_retention_release'
export const CLIENT_RETENTION_RELEASE_COUNTER_ID = 'clientRetentionReleases'
export const formatClientRetentionReleaseNumber = (n) => `CRR-${String(n).padStart(4, '0')}`

export const postedClientRetentionReleases = (releases) =>
  (releases ?? []).filter(r => r?.status === CRR_STATUS.POSTED)

export const draftClientRetentionReleases = (releases) =>
  (releases ?? []).filter(r => r?.status === CRR_STATUS.DRAFT)

// Retention can be released only on an ISSUED invoice that withheld some.
export const isReleasableClientInvoice = (invoice) =>
  invoice?.status === CI_STATUS.ISSUED && hasRetention(invoice)

// The stored money of a release against the invoice's CURRENT ledger.
// Returns { error } or { amount, gstAmount, releaseTotal, ledgerSeq }.
export function buildClientRetentionRelease(invoice, ledgerDoc, amount) {
  const ledgerState = readLedger(ledgerDoc)
  const allocation = allocateRelease(invoice, ledgerState, amount)
  if (allocation.error) return { error: allocation.error }
  return {
    amount:       fromCents(allocation.amountCents),
    gstAmount:    fromCents(allocation.gstCents),
    releaseTotal: fromCents(allocation.amountCents + allocation.gstCents),
    ledgerSeq:    ledgerState.seq,
  }
}

export function validateClientReleaseDraft({ clientInvoiceId, amount, releaseDate, reason }, { invoice = null, ledgerDoc = null } = {}) {
  if (!clientInvoiceId) return 'Choose the client invoice whose retention is being released.'
  const value = Number(amount)
  if (!Number.isFinite(value)) return 'Enter the release amount (ex-GST) as a number.'
  if (toCents(value) <= 0) return 'The release amount must be greater than zero.'
  if (!isIsoDateShape(releaseDate)) return 'Enter the date this release was agreed.'
  if (!String(reason || '').trim()) return 'Enter a reason for releasing this retention.'
  if (invoice) {
    if (invoice.id !== clientInvoiceId) return 'The supplied invoice does not match the selected target.'
    if (invoice.status !== CI_STATUS.ISSUED) {
      return `${invoice.invoiceNumber} is ${invoice.status} — retention can only be released on an issued client invoice.`
    }
    if (!hasRetention(invoice)) return `${invoice.invoiceNumber} withheld no retention.`
    const built = buildClientRetentionRelease(invoice, ledgerDoc, value)
    if (built.error) return built.error
  }
  return null
}

export function clientReleasePostBlockedReason(release, invoice, ledgerDoc) {
  if (!release) return 'Retention release not found.'
  if (release.status !== CRR_STATUS.DRAFT) {
    return `Only a draft retention release can be posted — this one is ${release.status}.`
  }
  if (!invoice) return 'The client invoice could not be found on this project.'
  if (!isReleasableClientInvoice(invoice)) {
    return `${invoice.invoiceNumber} is ${invoice.status} — retention can only be released on an issued client invoice that withheld some.`
  }
  // Stale means the figures would differ (what the server checks) — not that
  // the ledger sequence moved: a receipt steps it without changing a release.
  const rebuilt = buildClientRetentionRelease(invoice, ledgerDoc, release.amount)
  if (rebuilt.error) return rebuilt.error
  if (toCents(rebuilt.gstAmount) !== toCents(release.gstAmount)
    || toCents(rebuilt.releaseTotal) !== toCents(release.releaseTotal)) return CLIENT_ENTRY_STALE_TEXT
  return null
}

// A posted release whose invoice is no longer issued or readable. Rules refuse
// to void an invoice that carries a posted release, so this is reachable only
// when the invoice cannot be read; it is reported, never hidden.
export function clientReleaseExceptions(releases, invoices) {
  const byId = new Map((invoices ?? []).map(inv => [inv.id, inv]))
  const out = []
  for (const r of postedClientRetentionReleases(releases)) {
    const inv = byId.get(r?.clientInvoiceId)
    const reason = !inv
      ? 'The client invoice this release belongs to no longer exists or is not readable.'
      : inv.status !== CI_STATUS.ISSUED
        ? `${inv.invoiceNumber} is ${inv.status} — retention can only be released on an issued client invoice.`
        : !hasRetention(inv)
          ? `${inv.invoiceNumber} withheld no retention, so this release has nothing to release.`
          : null
    if (!reason) continue
    out.push({
      releaseId: r.id, releaseNumber: r.releaseNumber,
      invoiceNumber: r.invoiceNumber || inv?.invoiceNumber || '—',
      releaseTotal: fromCents(toCents(r.releaseTotal)), reason,
    })
  }
  return out
}

export const countingClientRetentionReleases = (releases, invoices) => {
  const failing = new Set(clientReleaseExceptions(releases, invoices).map(e => e.releaseId))
  return postedClientRetentionReleases(releases).filter(r => !failing.has(r.id))
}

export const CLIENT_RETENTION_HELD_NOTICE =
  'Client retention held is retention the client withheld on an issued invoice that has NOT been released. It ' +
  'was billed and counts as issued, but it is not receivable yet, is excluded from Forecast Cash In, and is ' +
  'never reduced by a receipt.'

export const CLIENT_RETENTION_RELEASED_NOTICE =
  'A posted release makes that retention receivable on its invoice — it joins the invoice balance and is ' +
  'settled by an ordinary Client Receipt. A release is not an invoice, a credit note or a receipt, and moves ' +
  'no cash by itself. Released retention ages from the invoice due date; release due dates are not modelled.'

export const CLIENT_RETENTION_READ_UNAVAILABLE_NOTICE =
  'Client retention releases could not be loaded. Released retention is part of what is receivable, so every ' +
  'figure that depends on it is shown as Unavailable rather than as though nothing has been released.'
