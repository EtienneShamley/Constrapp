import { GST_RATE, roundMoney } from './purchaseOrders'
import { safeAmount, toCents, isIsoDateShape } from './payments'
import { SI_STATUS } from './supplierInvoices'
import { isPayableInvoice, normaliseSupplierName, isLegacyNameMatch } from './supplierPayments'

// ── Supplier Retention (register) & Retention Release ────────────────────────
//
// Retention is withheld on a Supplier Invoice at posting time and is NOT payable
// on that invoice: `payableTotal = grossTotal − retentionTotal`
// (lib/supplierInvoices.js → invoiceTotals). Before this module existed, retained
// money had no route to ever becoming payable.
//
// A RETENTION RELEASE is the new authored commercial event that makes part or
// all of that already-withheld retention payable.
//
// ⚠️ A RETENTION RELEASE IS NOT A SUPPLIER INVOICE, NOT A TAX INVOICE, NOT A
// CREDIT NOTE, AND NOT A PAYMENT. It is an INTERNAL COMMERCIAL AUTHORISATION.
// It creates no taxable supply, no cost, and no cash movement: only a posted
// Supplier Payment moves cash, and the cost was already recognised in full when
// the invoice posted (invoicedByCostCode sums the FULL ex-GST lines and has never
// subtracted retention). No budget, forecast, or margin figure changes here.
//
// ⚠️ NOTHING IS EVER WRITTEN ONTO A SUPPLIER INVOICE. `retention`,
// `retentionGst`, and `retentionTotal` are immutable for the life of the
// document — never reduced, never cleared, never stamped with a release
// reference. Released amounts are DERIVED at read time from release documents
// (ADR-3/ADR-4), which is exactly why voiding a release restores every balance
// at the next render with no reversal document.
//
// THE HYBRID SOURCE OF TRUTH:
//   · HELD     — derived from posted supplier invoices (retentionTotal)
//   · RELEASED — derived from POSTED retentionReleases (this module)
//   · PAID     — derived from posted Supplier Payment allocations (unchanged)
//
// ⚠️ RETENTION *PAID* IS NOT DERIVABLE AND IS NOT MODELLED. A payment allocation
// settles the invoice's balance as ONE balance; nothing identifies which band of
// that balance (original payable vs released retention) the money settled.
// Inventing an ordering convention would be an accounting policy Constrapp does
// not make on the user's behalf (the allocateOldestFirst precedent). This module
// therefore reports Held / Released and NEVER "released but unpaid".

export const RETENTION_RELEASE_COUNTER_ID = 'retentionReleases'

export const RR_DOC_TYPE = 'retention_release'

// ── Lifecycle ────────────────────────────────────────────────────────────────
//
//   draft ──▶ posted ──▶ void        (void is terminal)
//     └────────────────▶ void
//
// `posted` is the financial commit point: only a posted release contributes to
// the derived payable basis. There is deliberately NO `paid` status — payment
// state is derived from Supplier Payment allocations and must never have a
// second source of truth (ADR-24).
export const RR_STATUS = {
  DRAFT:  'draft',
  POSTED: 'posted',
  VOID:   'void',
}

export const RR_STATUS_LABELS = {
  [RR_STATUS.DRAFT]:  'Draft',
  [RR_STATUS.POSTED]: 'Posted',
  [RR_STATUS.VOID]:   'Void',
}

// Maps each status onto an existing Badge variant — no new colours.
export const RR_BADGE_VARIANTS = {
  [RR_STATUS.DRAFT]:  'soon',
  [RR_STATUS.POSTED]: 'active',
  [RR_STATUS.VOID]:   'danger',
}

// Forward-only. Void is terminal; there is no un-post and no return to draft.
// Also enforced by Firestore rules — this map stays the single client-side
// source of truth so the UI and the rules cannot drift.
export const RR_TRANSITIONS = {
  [RR_STATUS.DRAFT]:  [RR_STATUS.POSTED, RR_STATUS.VOID],
  [RR_STATUS.POSTED]: [RR_STATUS.VOID],
  [RR_STATUS.VOID]:   [],
}

export const canTransition = (from, to) => (RR_TRANSITIONS[from] ?? []).includes(to)

// The single counting point. A draft has released nothing; a void release
// released nothing (or the record was wrong).
export const RR_COUNTING_STATUSES = [RR_STATUS.POSTED]

// Content is editable only while draft. Posting freezes everything —
// rules-enforced; voiding is then the only permitted update.
export const RR_EDITABLE_STATUSES = [RR_STATUS.DRAFT]

export const formatRetentionReleaseNumber = (n) => `RR-${String(n).padStart(4, '0')}`

// ── Release sets ─────────────────────────────────────────────────────────────

export const postedRetentionReleases = (releases) =>
  (releases ?? []).filter(r => RR_COUNTING_STATUSES.includes(r?.status))

export const draftRetentionReleases = (releases) =>
  (releases ?? []).filter(r => r?.status === RR_STATUS.DRAFT)

export const voidRetentionReleases = (releases) =>
  (releases ?? []).filter(r => r?.status === RR_STATUS.VOID)

// ── GST: the cumulative-snapshot model ───────────────────────────────────────
//
// Retention carries its OWN GST on the supplier invoice
// (`retentionGst = retention × 10%`), withheld together with the retention, so
// releasing retention releases that GST with it. Releasing the whole retention
// therefore releases exactly the stored `retentionTotal` — no new arithmetic.
//
// A PARTIAL release cannot simply round its own share: independent roundings
// drift, and after n partial releases the accumulated error can exceed a cent,
// so the last release would not reconcile to `retentionGst`.
//
// GST is therefore the DIFFERENCE OF TWO CUMULATIVE ROUNDINGS — the
// `previouslyApproved` idiom already used by Progress Claims:
//
//   newCumulative = previouslyReleasedAmount + amount
//   gstAmount     = roundMoney(newCumulative × 10%)
//                 − roundMoney(previouslyReleasedAmount × 10%)
//   releaseTotal  = amount + gstAmount
//
// The sum TELESCOPES across contiguous releases:
//
//   Σ gstAmount    = roundMoney(totalReleased × 10%) − roundMoney(0)
//                  = roundMoney(totalReleased × 10%)
//
// so when the cumulative released amount reaches `invoice.retention`:
//
//   Σ gstAmount    == roundMoney(retention × 10%) == invoice.retentionGst   EXACTLY
//   Σ releaseTotal == retention + retentionGst    == invoice.retentionTotal EXACTLY
//
// for ANY number of partial releases and any drift-prone value. This is also the
// exact formula Firestore rules re-derive per document (see firestore.rules →
// retentionReleases), so a write the client considers valid is never rejected
// there, and an arbitrary `gstAmount` is rejected outright rather than tolerated.

// GST on a cumulative ex-GST released amount — ONE rounding, never composed.
export const cumulativeRetentionGst = (cumulativeExGst) =>
  roundMoney(safeAmount(cumulativeExGst) * GST_RATE)

// The GST attributable to THIS release: the cumulative delta described above.
export function releaseGstAmount(previouslyReleasedAmount, amount) {
  const prev = roundMoney(safeAmount(previouslyReleasedAmount))
  const next = roundMoney(prev + roundMoney(safeAmount(amount)))
  return roundMoney(cumulativeRetentionGst(next) - cumulativeRetentionGst(prev))
}

// The full derived money shape of one release. The caller stores all four
// fields; rules re-derive `gstAmount` and `releaseTotal` from the first two.
export function releaseTotals(previouslyReleasedAmount, amount) {
  const prev      = roundMoney(safeAmount(previouslyReleasedAmount))
  const released  = roundMoney(safeAmount(amount))
  const gstAmount = releaseGstAmount(prev, released)
  return {
    previouslyReleasedAmount: prev,
    amount:                   released,
    gstAmount,
    releaseTotal:             roundMoney(released + gstAmount),
  }
}

// ── Read-time release derivations ────────────────────────────────────────────

// { supplierInvoiceId: Σ releaseTotal } across POSTED releases only — the GROSS
// map that raises each invoice's derived payable basis.
//
// This is the ONE map that crosses the calculation boundary into
// lib/supplierPayments.js and lib/cashFlow.js. It is the exact structural mirror
// of paidByInvoice(payments): same posting filter, same shape, and the same
// consequence — voiding a release restores every balance immediately, with no
// reversal document and no write to the invoice.
export function releasedByInvoiceId(releases) {
  const map = {}
  for (const r of postedRetentionReleases(releases)) {
    if (!r?.supplierInvoiceId) continue
    map[r.supplierInvoiceId] = roundMoney((map[r.supplierInvoiceId] || 0) + safeAmount(r.releaseTotal))
  }
  return map
}

// { supplierInvoiceId: Σ amount } across POSTED releases — the EX-GST map.
// Used for the remaining-retention cap and for the `previouslyReleasedAmount`
// snapshot. Never used as a cash figure.
export function releasedExGstByInvoiceId(releases) {
  const map = {}
  for (const r of postedRetentionReleases(releases)) {
    if (!r?.supplierInvoiceId) continue
    map[r.supplierInvoiceId] = roundMoney((map[r.supplierInvoiceId] || 0) + safeAmount(r.amount))
  }
  return map
}

// Ex-GST retention already released against one invoice (posted releases only),
// optionally excluding one release — so editing a draft never counts itself.
export function releasedExGstForInvoice(releases, supplierInvoiceId, { excludeReleaseId = null } = {}) {
  const others = (releases ?? []).filter(r => r?.id !== excludeReleaseId)
  return roundMoney(safeAmount(releasedExGstByInvoiceId(others)[supplierInvoiceId]))
}

// Ex-GST retention still available to release on one invoice. Clamped at zero:
// a negative remainder would mean the invoice has been over-released, which is
// surfaced as an exception rather than offered as headroom.
export function remainingRetentionExGst(invoice, releasedExGst) {
  return Math.max(0, roundMoney(safeAmount(invoice?.retention) - safeAmount(releasedExGst)))
}

// ── Register rows ────────────────────────────────────────────────────────────

// The invoices that hold retention: POSTED supplier invoices with a non-zero
// retention. Draft/approved invoices have not committed anything, and cancelled
// invoices hold nothing — the same `isPayableInvoice` counting point Supplier
// Payments uses.
export const retentionInvoices = (invoices) =>
  (invoices ?? []).filter(inv => isPayableInvoice(inv) && toCents(safeAmount(inv.retentionTotal)) > 0)

// One row per retention-holding invoice, all derived. Nothing here is stored.
export function retentionInvoiceRows(invoices, releases) {
  const releasedGross = releasedByInvoiceId(releases)
  const releasedExGst = releasedExGstByInvoiceId(releases)

  return retentionInvoices(invoices).map((inv) => {
    const relTotal = roundMoney(safeAmount(releasedGross[inv.id]))
    const relExGst = roundMoney(safeAmount(releasedExGst[inv.id]))
    const retentionTotal = roundMoney(safeAmount(inv.retentionTotal))
    return {
      id:                    inv.id,
      invoiceNumber:         inv.invoiceNumber,
      supplierInvoiceNumber: inv.supplierInvoiceNumber || '',
      supplierId:            inv.supplierId ?? null,
      supplierName:          inv.supplierName || '',
      invoiceDate:           inv.invoiceDate || '',
      // The original withholding — IMMUTABLE, never reduced by a release.
      retention:      roundMoney(safeAmount(inv.retention)),
      retentionGst:   roundMoney(safeAmount(inv.retentionGst)),
      retentionTotal,
      // Released to date (posted releases only).
      releasedExGst:  relExGst,
      releasedGst:    roundMoney(relTotal - relExGst),
      releasedTotal:  relTotal,
      // Still held: not released, therefore not payable.
      retentionHeld:  Math.max(0, roundMoney(retentionTotal - relTotal)),
      remainingRetentionExGst: remainingRetentionExGst(inv, relExGst),
      fullyReleased:  toCents(retentionTotal - relTotal) <= 0,
      legacyNameMatch: isLegacyNameMatch(inv),
    }
  })
}

// Groups the rows by supplier. Keys on supplierId when present, falling back to
// the frozen supplierName for pre-Contacts (supplierId: null) invoices, which
// are NEVER backfilled (ADR-15) — the supplierMatchesInvoice precedent.
export function retentionBySupplier(invoices, releases) {
  const rows = retentionInvoiceRows(invoices, releases)
  const groups = new Map()

  for (const row of rows) {
    const key = row.supplierId ? `id:${row.supplierId}` : `name:${normaliseSupplierName(row.supplierName)}`
    const group = groups.get(key) ?? {
      key,
      supplierId:    row.supplierId,
      supplierName:  row.supplierName,
      invoiceCount:  0,
      retentionTotal: 0,
      releasedTotal:  0,
      retentionHeld:  0,
      legacyNameMatch: false,
      rows: [],
    }
    group.invoiceCount   += 1
    group.retentionTotal  = roundMoney(group.retentionTotal + row.retentionTotal)
    group.releasedTotal   = roundMoney(group.releasedTotal + row.releasedTotal)
    group.retentionHeld   = roundMoney(group.retentionHeld + row.retentionHeld)
    group.legacyNameMatch = group.legacyNameMatch || row.legacyNameMatch
    group.rows.push(row)
    groups.set(key, group)
  }

  for (const group of groups.values()) {
    group.rows.sort((a, b) => (a.invoiceDate || '').localeCompare(b.invoiceDate || '')
                           || (a.invoiceNumber || '').localeCompare(b.invoiceNumber || ''))
  }

  return [...groups.values()].sort((a, b) => a.supplierName.localeCompare(b.supplierName))
}

// Project-level totals for the register summary.
//
// ⚠️ There is deliberately NO "released but unpaid" figure — see the module
// header. `releasedToDate` is a CUMULATIVE statistic, never an outstanding,
// unpaid, or forecast cash figure.
export function retentionSummary(invoices, releases) {
  const rows = retentionInvoiceRows(invoices, releases)
  let totalWithheld = 0
  let releasedToDate = 0
  let retentionHeld = 0
  for (const row of rows) {
    totalWithheld  = roundMoney(totalWithheld + row.retentionTotal)
    releasedToDate = roundMoney(releasedToDate + row.releasedTotal)
    retentionHeld  = roundMoney(retentionHeld + row.retentionHeld)
  }
  const suppliers = new Set(
    rows.map(r => (r.supplierId ? `id:${r.supplierId}` : `name:${normaliseSupplierName(r.supplierName)}`)),
  )
  return {
    totalWithheld,
    releasedToDate,
    retentionHeld,
    invoiceCount:  rows.length,
    supplierCount: suppliers.size,
  }
}

// ── Release exceptions ───────────────────────────────────────────────────────
//
// A POSTED release whose target invoice is later cancelled (or becomes
// unreadable) contributes to no register row, because rows iterate POSTED
// invoices only. Rather than let it vanish silently, it is surfaced here.
//
// ⚠️ ADR-40 NARROWED THIS. A posted supplier invoice is now RULES-IMMUTABLE and
// RULES-TERMINAL, so no caller can cancel a posted invoice a release targets;
// the cancelled-target case is reachable only for invoices tampered with before
// ADR-40, or where the target became unreadable. The exception path is retained
// unchanged — voiding a release must stay possible even when its target is gone,
// and rules deliberately do NOT re-validate the target on void for exactly that
// reason. Constrapp surfaces the result rather than automating a fix — the
// allocationExceptions philosophy:
//
//   · the RELEASE stays recorded, exactly as authored;
//   · nothing is deleted, reassigned, or reversed automatically;
//   · the supplier invoice is never modified.
export function releaseExceptions(releases, invoices) {
  const byId = new Map((invoices ?? []).map(inv => [inv.id, inv]))
  const out = []
  for (const r of postedRetentionReleases(releases)) {
    const inv = byId.get(r?.supplierInvoiceId)
    const reason = !inv
      ? 'The released supplier invoice no longer exists or is not readable.'
      : inv.status === SI_STATUS.CANCELLED
        ? `${inv.invoiceNumber} was cancelled after this retention release was posted. Posted supplier-invoice lifecycle is not yet enforced by Firestore rules, so this can happen through a direct SDK call.`
        : !isPayableInvoice(inv)
          ? `${inv.invoiceNumber} is ${inv.status} — retention can only be released on a posted supplier invoice.`
          : toCents(safeAmount(inv.retentionTotal)) <= 0
            ? `${inv.invoiceNumber} holds no retention, so this release has nothing to release.`
            : null
    if (!reason) continue
    out.push({
      releaseId:             r.id,
      releaseNumber:         r.releaseNumber,
      invoiceNumber:         r.invoiceNumber || inv?.invoiceNumber || '—',
      supplierInvoiceNumber: r.supplierInvoiceNumber || inv?.supplierInvoiceNumber || '',
      supplierName:          r.supplierName || inv?.supplierName || '',
      releaseTotal:          roundMoney(safeAmount(r.releaseTotal)),
      reason,
    })
  }
  return out
}

export const RELEASE_EXCEPTION_REMEDY =
  'The retention release remains recorded — nothing is reversed automatically and the supplier invoice is never ' +
  'modified. Investigate first; where the release itself was wrong, void it with a reason. A voided release ' +
  'contributes nothing to any payable balance from the next render.'

// Posted releases that over-release an invoice's retention. This can only arise
// from concurrent posting or a direct SDK write — the normal UI hard-blocks it
// (see validateReleaseDraft / postBlockedReason) — so it is reported, never hidden.
export function overReleasedRows(rows) {
  return (rows ?? []).filter(r => toCents(r.releasedTotal - r.retentionTotal) > 0)
}

// ── Validation (client-enforced — NOT the security boundary) ─────────────────
//
// ⚠️ CLIENT-ENFORCED. Firestore rules enforce the document SHAPE, the lifecycle,
// the target invoice (exists + posted), the PER-DOCUMENT cap
// (previouslyReleasedAmount + amount ≤ invoice.retention), and the exact GST
// formula. They CANNOT sum sibling release documents, so they cannot verify that
// `previouslyReleasedAmount` is truthful and cannot enforce the CUMULATIVE cap.
// Two clients can compute the same remaining retention concurrently and both
// writes succeed. See docs/SECURITY.md → Deferred Control 24.
//
// The checks below are what stop the NORMAL UI from ever knowingly creating an
// over-release. They are a correctness guard, never a security guarantee.

// Returns an error message, or null when the draft is saveable.
//
// `releases` must be the CURRENTLY LOADED release set. A caller that cannot read
// releases must not call this — it must disable the action entirely, because an
// empty list would silently read as "nothing released yet".
export function validateReleaseDraft({
  supplierInvoiceId, amount, releaseDate, reason,
  invoices = null, releases = null, excludeReleaseId = null,
}) {
  if (!supplierInvoiceId) return 'Choose the supplier invoice whose retention is being released.'

  const value = Number(amount)
  if (!Number.isFinite(value)) return 'Enter the release amount (ex-GST) as a number.'
  if (toCents(value) <= 0) return 'The release amount must be greater than zero.'

  if (!isIsoDateShape(releaseDate)) return 'Enter the date this release was agreed.'
  if (!String(reason || '').trim()) return 'Enter a reason for releasing this retention.'

  if (invoices) {
    const invoice = (invoices ?? []).find(inv => inv.id === supplierInvoiceId)
    if (!invoice) return 'The selected supplier invoice could not be found on this project.'
    if (!isPayableInvoice(invoice)) {
      return `${invoice.invoiceNumber} is ${invoice.status} — retention can only be released on a posted supplier invoice.`
    }
    if (toCents(safeAmount(invoice.retentionTotal)) <= 0) {
      return `${invoice.invoiceNumber} holds no retention.`
    }

    // THE CUMULATIVE CAP — hard-blocked here, never merely warned. Rules cannot
    // enforce it (they cannot sum siblings), so the UI must never knowingly
    // create an over-release.
    if (releases) {
      const alreadyReleased = releasedExGstForInvoice(releases, supplierInvoiceId, { excludeReleaseId })
      const available = remainingRetentionExGst(invoice, alreadyReleased)
      if (toCents(value) > toCents(available)) {
        return `Only ${available.toFixed(2)} of retention (ex-GST) remains available to release on ${invoice.invoiceNumber}. `
             + `${alreadyReleased.toFixed(2)} of ${roundMoney(safeAmount(invoice.retention)).toFixed(2)} has already been released.`
      }
    }
  }

  return null
}

// Why a draft release cannot be posted yet, or null when it can.
//
// Posting re-checks the cap against the CURRENT posted release set, because a
// sibling release may have been posted since this draft was saved. When the
// stored `previouslyReleasedAmount` snapshot has gone stale the draft is
// blocked rather than silently corrected: posting is a status-only operation
// (rules permit no content change), so its GST would otherwise no longer
// telescope. Re-saving the draft recomputes both.
export function postBlockedReason(release, invoices = null, releases = null) {
  if (!release) return 'Retention release not found.'
  if (release.status !== RR_STATUS.DRAFT) {
    return `Only a draft retention release can be posted — this one is ${release.status}.`
  }

  if (invoices) {
    const invoice = (invoices ?? []).find(inv => inv.id === release.supplierInvoiceId)
    if (!invoice) return 'The released supplier invoice could not be found on this project.'
    if (!isPayableInvoice(invoice)) {
      return `${invoice.invoiceNumber} is ${invoice.status} — retention can only be released on a posted supplier invoice.`
    }

    if (releases) {
      const alreadyReleased = releasedExGstForInvoice(releases, release.supplierInvoiceId, { excludeReleaseId: release.id })
      if (toCents(alreadyReleased) !== toCents(release.previouslyReleasedAmount)) {
        return 'Another retention release has been posted on this invoice since this draft was prepared. '
             + 'Re-open and save the draft to refresh its figures, then post it.'
      }
      const available = remainingRetentionExGst(invoice, alreadyReleased)
      if (toCents(safeAmount(release.amount)) > toCents(available)) {
        return `Only ${available.toFixed(2)} of retention (ex-GST) remains available to release on ${invoice.invoiceNumber}.`
      }
    }
  }

  return null
}

// ── Standing notices (honest about what is and is not enforced) ──────────────

export const RETENTION_HELD_NOTICE =
  'Retention held is retention withheld on a posted supplier invoice that has NOT been released. It is not '
  + 'payable, is excluded from Forecast Cash Out, and is never reduced by a payment.'

export const RETENTION_RELEASED_NOTICE =
  'A posted retention release makes that amount payable on its supplier invoice — it appears in Remaining '
  + 'Payable and is settled by an ordinary Supplier Payment. A release is an internal commercial '
  + 'authorisation, not a supplier invoice, tax invoice, credit note, or payment, and moves no cash by itself.'

export const RETENTION_RELEASE_CONCURRENCY_NOTICE =
  'Constrapp blocks a release that exceeds the retention still available on an invoice, using the releases '
  + 'loaded now. Firestore rules cannot sum sibling releases, so two people releasing the same retention at the '
  + 'same moment can still both succeed — the register reports any over-release rather than hiding it.'

export const RETENTION_PAID_NOTICE =
  'Retention paid is not reported: a payment settles a supplier invoice balance as one balance, and nothing '
  + 'identifies whether the money settled the original payable or released retention.'
