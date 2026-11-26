// ── Client finance activation (ADR-87 / ADR-88 / ADR-89) ─────────────────────
//
// Client credit notes and client retention are released per COMPANY: a boolean
// only the trusted backend writes, `companies/{companyId}.clientFinanceEnabled`.
//
// ⚠️ UX ONLY. Nothing here enforces anything. Firestore Rules refuse, for a
// company without the flag, a client invoice carrying retention and a draft
// client credit note or client retention release; the backend refuses to post
// one. These helpers only keep the browser from offering what would be refused.
//
// STRICT: only the boolean `true` activates. A company that is still loading,
// could not be read, or does not carry the field is NOT activated — never the
// other way round.

export const CLIENT_FINANCE_NOT_ACTIVATED_TEXT =
  'Client credit notes and client retention are not yet available for this company.'

// One definition, shared with the trusted backend's bundle.
export { clientFinanceActivated } from './clientEntryShape'

// The retention a client invoice draft is saved with: the authored amount for
// an activated company, always zero otherwise (the Rules refuse anything else).
export function retentionToSave(activated, amount) {
  return activated === true ? amount : 0
}

// Navigation entries flagged `clientFinance: true` are offered only to an
// activated company. Every other entry is returned untouched, in order.
export function clientFinanceTabs(tabs, activated) {
  return activated === true ? tabs : tabs.filter(tab => tab.clientFinance !== true)
}

// A section listing client-finance RECORDS is shown to an activated company
// always, and to any other company only when there is something in it —
// existing records are never hidden, an empty invitation is never shown.
export function showClientFinanceRecords(activated, count) {
  return activated === true || count > 0
}
