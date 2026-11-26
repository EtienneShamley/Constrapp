import { fromCents } from './money'
import { issuedClientInvoices } from './clientInvoices'
import { countingClientCreditNotes, creditedByVariation } from './clientCreditNotes'
import { countingClientRetentionReleases } from './clientRetention'
import { expectedLedgerTotals, ledgerPosition, ledgerDisagreement, readLedger } from './clientLedger'

// ── The ONE receivable contract (ADR-87 / ADR-88) ────────────────────────────
//
// Every surface that states what a client owes — the Client Invoices register,
// the receipt allocation picker, AR ageing, Forecast Cash In, the Commercial
// Report, Portfolio and the Final Account — takes its figures from here, so
// they cannot disagree. Derived at READ TIME from the documents themselves:
// issued invoices, posted credit notes that pass the validity gate, and posted
// retention releases. Nothing is stored and nothing is read from the ledger.
//
// THE FIGURES THAT MUST NOT BLUR (all per invoice, gross unless named):
//
//   grossTotal        what was billed, inc. GST — never reduced by anything
//   credited          posted credit notes (gross); creditedSubtotal is ex-GST
//   netIssuedSubtotal subtotal − creditedSubtotal — what counts as Issued
//   retentionTotal    withheld on the invoice (immutable)
//   retentionHeld     retentionTotal − released − the retention part of credits:
//                     billed, NOT receivable yet
//   releasedTotal     retention made receivable by posted releases
//   receivableBasis   grossTotal − credited − retentionHeld
//                     — what the client owes NOW, before receipts
//
// Cash received is a receipt figure and is applied by lib/clientReceipts.js:
//   remaining = receivableBasis − received      (signed; negative = owed to the client)
//
// The map this module returns crosses the calculation boundary explicitly (the
// ADR-30 pattern): lib/clientReceipts.js and lib/cashFlow.js are handed it and
// import nothing from here. An empty map reproduces every pre-ADR-87 figure for
// invoices that withhold no retention.

// { invoiceId: position } for every ISSUED invoice, amounts in currency units.
export function receivablePositions(invoices, creditNotes = [], releases = []) {
  const counting = countingClientCreditNotes(creditNotes, invoices)
  const released = countingClientRetentionReleases(releases, invoices)
  const map = {}
  for (const invoice of issuedClientInvoices(invoices)) {
    const p = ledgerPosition(invoice, expectedLedgerTotals(invoice.id, counting, released))
    map[invoice.id] = {
      subtotal:           fromCents(p.subtotalCents),
      grossTotal:         fromCents(p.grossCents),
      creditedSubtotal:   fromCents(p.creditedSubtotalCents),
      creditedGst:        fromCents(p.creditedGstCents),
      credited:           fromCents(p.creditedGrossCents),
      netIssuedSubtotal:  fromCents(p.netIssuedSubtotalCents),
      netIssuedGross:     fromCents(p.netIssuedGrossCents),
      retentionTotal:     fromCents(p.retentionTotalCents),
      releasedTotal:      fromCents(p.releasedGrossCents),
      creditedRetention:  fromCents(p.creditedRetentionGrossCents),
      retentionHeld:      fromCents(p.retentionHeldCents),
      retentionHeldExGst: fromCents(p.retentionHeldExCents),
      receivableBasis:    fromCents(p.receivableBasisCents),
    }
  }
  return map
}

// Project totals of the positions above (currency units).
export function receivableTotals(positions) {
  const sum = (key) => fromCents(Object.values(positions ?? {}).reduce((s, p) => s + Math.round((p[key] || 0) * 100), 0))
  return {
    creditedSubtotal: sum('creditedSubtotal'),
    creditedGst:      sum('creditedGst'),
    credited:         sum('credited'),
    retentionTotal:   sum('retentionTotal'),
    releasedTotal:    sum('releasedTotal'),
    creditedRetention: sum('creditedRetention'),
    retentionHeld:    sum('retentionHeld'),
  }
}

// Everything a composer needs, derived once.
export function receivableContext(invoices, creditNotes = [], releases = []) {
  const positions = receivablePositions(invoices, creditNotes, releases)
  return {
    positions,
    totals: receivableTotals(positions),
    creditedByVariation: creditedByVariation(creditNotes, invoices),
  }
}

// ── Client retention register rows ───────────────────────────────────────────
export function clientRetentionRows(invoices, positions) {
  return issuedClientInvoices(invoices)
    .filter(inv => (positions?.[inv.id]?.retentionTotal || 0) > 0)
    .map(inv => {
      const p = positions[inv.id]
      return {
        id: inv.id,
        invoiceNumber: inv.invoiceNumber,
        clientId: inv.clientId ?? null,
        clientName: inv.clientName || '',
        invoiceDate: inv.invoiceDate || '',
        retentionTotal: p.retentionTotal,
        releasedTotal: p.releasedTotal,
        creditedRetention: p.creditedRetention,
        retentionHeld: p.retentionHeld,
        retentionHeldExGst: p.retentionHeldExGst,
        fullyResolved: Math.round(p.retentionHeld * 100) <= 0,
      }
    })
    .sort((a, b) => (a.invoiceDate || '').localeCompare(b.invoiceDate || '')
                 || (a.invoiceNumber || '').localeCompare(b.invoiceNumber || ''))
}

// ── Ledger cross-check ───────────────────────────────────────────────────────
//
// A stored ledger must equal the sum of the posted documents it guards. A
// difference cannot arise through the app (only the trusted backend posts, and
// it writes the ledger with every entry — ADR-89); it would mean a document was altered outside it. Reported,
// never hidden — and the FIGURES still follow the documents.
export function ledgerExceptions(invoices, ledgers, creditNotes = [], releases = []) {
  const ledgerById = new Map((ledgers ?? []).map(l => [l.id, l]))
  const posted = (creditNotes ?? []).filter(cn => cn?.status === 'posted')
  const postedReleases = (releases ?? []).filter(r => r?.status === 'posted')
  const out = []
  for (const invoice of invoices ?? []) {
    const ledgerDoc = ledgerById.get(invoice.id) ?? null
    const keys = ledgerDisagreement(ledgerDoc, invoice.id, posted, postedReleases)
    if (keys.length === 0) continue
    out.push({
      invoiceId: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      keys,
      seq: readLedger(ledgerDoc).seq,
      reason: `The ledger of ${invoice.invoiceNumber} does not equal the credit notes and retention releases posted against it.`,
    })
  }
  return out
}
