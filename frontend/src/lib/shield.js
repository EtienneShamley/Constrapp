import { roundMoney, PO_STATUS, PO_STATUS_LABELS, PO_COMMITTED_STATUSES, revisedCommitmentByPoLine } from './purchaseOrders'
import {
  CLAIM_STATUS_LABELS, CLAIM_OPEN_STATUSES, CLAIM_APPROVED_STATUSES, recognisedClaimsByPoLine,
  variationOriginClaimLines, claimVariationLineIssue, CLAIM_VARIATION_LINE_ISSUE_LABELS,
} from './progressClaims'
import {
  SI_STATUS, SI_STATUS_LABELS, SI_COUNTING_STATUSES,
  invoiceTotals, normaliseInvoiceRef, postedInvoicedByPoLine, postedInvoicedByPo, postedInvoicedByVariationLine, invoicedClaimIds,
} from './supplierInvoices'
import { remainingCommitment } from './commitment'
import { sourceLineIdentityError, sourceLineLabel } from './sourceLine'
import { toCents, safeAmount } from './payments'
import {
  normaliseSupplierName, allocationExceptions, payablesSummary, overReconciledPayableRows,
  postedSupplierPayments,
} from './supplierPayments'
import { creditNoteExceptions, postedSupplierCreditNotes } from './supplierCreditNotes'
import {
  releaseExceptions, overReleasedRows, retentionInvoiceRows, releasedByInvoiceId, postedRetentionReleases,
} from './retention'
import {
  VARIATION_TYPE, VARIATION_APPROVED_STATUSES, approvedSupplierVariationsTotal,
  appliedSupplierVariationAdjustments, isCommitmentApplied, classifyCommitmentLines,
} from './variations'
import { mixedModePoLineConflicts } from './poLineRecognition'
import { figureState, FIGURE_STATE, SNAPSHOT_SOURCE_LABELS } from './projectSnapshot'

// ── Constrapp SHIELD™ foundation — commercial assurance checks (ADR-50) ──────
//
// A DETERMINISTIC, READ-ONLY layer over the project's existing commercial
// records. SHIELD is COMMERCIAL ASSURANCE: it lists objective exceptions and
// conditions that need a human's review, with the source records beside them.
// It is not safety management, not fraud detection, not a compliance
// certification and not a prediction — and a finding is never proof that
// anyone did anything wrong.
//
// Every check is decided from existing selectors and status constants, carried
// through unchanged:
//
//   Supplier invoice identity and totals
//                          → lib/supplierInvoices.js  normaliseInvoiceRef /
//                            invoiceTotals / postedInvoicedByPoLine /
//                            postedInvoicedByPo / SI_COUNTING_STATUSES
//   Supplier identity      → lib/supplierPayments.js  normaliseSupplierName
//   PO and claim lifecycle → lib/purchaseOrders.js / lib/progressClaims.js
//                            status constants
//   Approved supplier variations on a PO
//                          → lib/variations.js  approvedSupplierVariationsTotal
//   Applied variation adjustments (M3-B1, ADR-62)
//                          → lib/variations.js  appliedSupplierVariationAdjustments
//                            and lib/purchaseOrders.js  revisedCommitmentByPoLine
//                            (the same revised PO-line value Remaining Committed
//                            nets — check 3 compares against it; check 4 lists
//                            the applied lines that could not be incorporated)
//   Mixed-mode PO lines     → lib/poLineRecognition.js  mixedModePoLineConflicts
//                            (ADR-55 — the same posted-direct and recognised-
//                            claim maps Remaining Committed nets)
//   Already-defined payable exceptions
//                          → lib/supplierPayments.js  allocationExceptions /
//                            payablesSummary / overReconciledPayableRows,
//                            lib/supplierCreditNotes.js  creditNoteExceptions
//                            (through creditTargetException),
//                            lib/retention.js  releaseExceptions /
//                            overReleasedRows / retentionInvoiceRows
//
// This module adds NO financial formula. It compares existing figures in
// whole cents (toCents), groups and counts records, filters lists and attaches
// availability. There is no score, no severity weighting, no threshold, no
// history, no prediction — and there must never be. Every check is ONE project
// in ONE currency (the caller's resolved project currency); nothing is summed
// across projects.
//
// Each check resolves to exactly one state (the PULSE vocabulary, ADR-47):
//
//   LOADING      a source it reads has not settled           (render "—")
//   UNAVAILABLE  a source it reads failed                    (never "no issue")
//   NEEDS_DATA   sources settled, but there is nothing the check can assess
//                yet, or the only records found are malformed
//   FINDING      the records support the condition
//   NO_ISSUE     complete, usable records were checked and the condition is
//                absent — a genuine negative, never a default
//
// Availability comes from lib/projectSnapshot.js → figureState: a dependency
// that is loading, failed or missing from `sourceStates` can never produce
// NO_ISSUE. Each check declares only the sources it actually reads
// (CHECK_DEPENDENCIES, perturbation-verified in tests), so one failed source
// never blocks an unrelated check.

export const SHIELD_STATE = {
  LOADING:     FIGURE_STATE.LOADING,
  UNAVAILABLE: FIGURE_STATE.UNAVAILABLE,
  NEEDS_DATA:  'needs_data',
  FINDING:     'finding',
  NO_ISSUE:    'no_issue',
}

export const SHIELD_STATE_ORDER = [
  SHIELD_STATE.FINDING, SHIELD_STATE.NEEDS_DATA, SHIELD_STATE.UNAVAILABLE,
  SHIELD_STATE.NO_ISSUE, SHIELD_STATE.LOADING,
]

export const SHIELD_STATE_LABELS = {
  [SHIELD_STATE.FINDING]:     'Findings',
  [SHIELD_STATE.NEEDS_DATA]:  'Needs data',
  [SHIELD_STATE.UNAVAILABLE]: 'Unavailable',
  [SHIELD_STATE.NO_ISSUE]:    'No issue found',
  [SHIELD_STATE.LOADING]:     'Loading',
}

export const CHECK = {
  DUPLICATE_INVOICE_REFERENCES: 'duplicateInvoiceReferences',
  INVOICE_INTEGRITY:            'supplierInvoiceIntegrity',
  PO_OVER_INVOICING:            'purchaseOrderOverInvoicing',
  COMMITMENT_STATE_CONFLICTS:   'commitmentStateConflicts',
  FINANCIAL_EXCEPTIONS:         'existingFinancialExceptions',
}

// A FIXED presentation order — not a ranking. Nothing here is "worse" than
// anything else; the page groups by state and keeps this order within a group.
export const CHECK_ORDER = [
  CHECK.DUPLICATE_INVOICE_REFERENCES,
  CHECK.INVOICE_INTEGRITY,
  CHECK.PO_OVER_INVOICING,
  CHECK.COMMITMENT_STATE_CONFLICTS,
  CHECK.FINANCIAL_EXCEPTIONS,
]

// Every subscription SHIELD reads — a strict subset of the Dashboard snapshot's
// sources. No budget, forecast, baseline or programme source is read.
export const SHIELD_SOURCES = [
  'purchaseOrders', 'progressClaims', 'supplierInvoices', 'supplierCreditNotes',
  'supplierPayments', 'retentionReleases', 'variations',
]

export const SHIELD_SOURCE_LABELS = Object.fromEntries(
  SHIELD_SOURCES.map(s => [s, SNAPSHOT_SOURCE_LABELS[s]]),
)

// The sources each check's selectors read — INCLUDING the sources behind its
// context columns and caveats, because those are part of the result:
//   · duplicates     — supplier invoices only
//   · integrity      — supplier invoices only
//   · over-invoicing — POs and posted invoices, plus variations for the
//                      revised (applied-variation) PO value and the context columns
//   · state conflict — POs, claims and invoices, plus variations for the
//                      applied-but-not-incorporated condition (F, ADR-62)
//   · exceptions     — the Remaining Payable composition (ADR-42): invoices,
//                      payments, credit notes and retention releases
export const CHECK_DEPENDENCIES = {
  [CHECK.DUPLICATE_INVOICE_REFERENCES]: ['supplierInvoices'],
  [CHECK.INVOICE_INTEGRITY]:            ['supplierInvoices'],
  [CHECK.PO_OVER_INVOICING]:            ['purchaseOrders', 'supplierInvoices', 'variations'],
  [CHECK.COMMITMENT_STATE_CONFLICTS]:   ['purchaseOrders', 'progressClaims', 'supplierInvoices', 'variations'],
  [CHECK.FINANCIAL_EXCEPTIONS]:         ['supplierInvoices', 'supplierPayments', 'supplierCreditNotes', 'retentionReleases'],
}

// Where each check sends the user to investigate — an existing project tab,
// relative to /projects/:projectId. No page accepts a URL filter today, so
// these are tab-level links, never invented record-level deep links.
const LINK = {
  invoices:  { to: 'invoices',                    label: 'Open Supplier Invoices' },
  pos:       { to: 'purchase-orders',             label: 'Open Purchase Orders' },
  claims:    { to: 'progress-claims',             label: 'Open Progress Claims' },
  payments:  { to: 'commercial/supplier-payments', label: 'Open Supplier Payments' },
  retention: { to: 'commercial/retention',         label: 'Open Retention' },
}

export const CHECK_LINKS = {
  [CHECK.DUPLICATE_INVOICE_REFERENCES]: [LINK.invoices],
  [CHECK.INVOICE_INTEGRITY]:            [LINK.invoices],
  [CHECK.PO_OVER_INVOICING]:            [LINK.pos, LINK.invoices],
  [CHECK.COMMITMENT_STATE_CONFLICTS]:   [LINK.pos, LINK.claims, LINK.invoices],
  [CHECK.FINANCIAL_EXCEPTIONS]:         [LINK.payments, LINK.invoices, LINK.retention],
}

export const CHECK_TITLES = {
  [CHECK.DUPLICATE_INVOICE_REFERENCES]: 'Potential duplicate supplier invoices',
  [CHECK.INVOICE_INTEGRITY]:            'Supplier invoice integrity',
  [CHECK.PO_OVER_INVOICING]:            'Purchase order over-invoicing exposure',
  [CHECK.COMMITMENT_STATE_CONFLICTS]:   'Commitment records requiring reconciliation',
  [CHECK.FINANCIAL_EXCEPTIONS]:         'Existing financial exceptions',
}

// Needs-data reasons, so the page can say exactly what is missing.
export const NEEDS_DATA_REASON = {
  NO_RECORDS:         'no_records',
  REFERENCES_MISSING: 'references_missing',
  MALFORMED_RECORDS:  'malformed_records',
}

// Evidence column kinds the page knows how to format. Money is formatted by
// the page with the project currency; the engine carries raw numbers.
export const COLUMN = {
  TEXT:  'text',
  MONEY: 'money',
  DATE:  'date',
  INT:   'int',
}

// ── Shared helpers (comparisons, grouping and counts — no formulas) ──────────

const isPositiveCents = (n) => toCents(n) > 0
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`

// The evaluated-check shape. `values` are selector outputs and counts;
// `evidence` rows are records (or selector rows) filtered, never re-derived.
function check(id, state, extra = {}) {
  return {
    id,
    title: CHECK_TITLES[id],
    links: CHECK_LINKS[id],
    state,
    failedSources: [],
    reason: null,
    headline: '',
    explanation: '',
    values: {},
    evidence: [],
    evidenceColumns: [],
    caveats: [],
    ...extra,
  }
}

// One availability check for every check: a loading or failed dependency
// short-circuits before the condition is evaluated, so no condition is ever
// judged on partial records.
function gate(id, sourceStates) {
  const s = figureState(CHECK_DEPENDENCIES[id], sourceStates)
  if (s.state === FIGURE_STATE.READY) return null
  return check(id, s.state, { failedSources: s.failedSources })
}

// Supplier identity key — the duplicateInvoiceWarnings / retentionBySupplier
// convention: a real supplierId when present; otherwise the normalised frozen
// name, for pre-Contacts (supplierId: null) documents only. Two documents with
// DIFFERENT real ids are never combined because their display names match, and
// a legacy null-id document is never combined with an id-bearing one.
const supplierKey = (doc) =>
  doc?.supplierId ? `id:${doc.supplierId}` : `name:${normaliseSupplierName(doc?.supplierName)}`

const siStatusLabel = (s) => SI_STATUS_LABELS[s] ?? String(s ?? '')
const poStatusLabel = (s) => PO_STATUS_LABELS[s] ?? String(s ?? '')
const claimStatusLabel = (s) => CLAIM_STATUS_LABELS[s] ?? String(s ?? '')

const NOT_WRONGDOING_CAVEAT =
  'A listed record is an exception or a condition needing review — not evidence of error or wrongdoing. ' +
  'Nothing here changes any figure, approval or document.'

// ── 1 · Potential duplicate supplier invoices ────────────────────────────────

const DUPLICATE_COLUMNS = [
  { key: 'supplierInvoiceNumber', label: 'Supplier ref',      kind: COLUMN.TEXT },
  { key: 'supplierName',          label: 'Supplier',          kind: COLUMN.TEXT },
  { key: 'invoiceNumber',         label: 'Invoice',           kind: COLUMN.TEXT },
  { key: 'statusLabel',           label: 'Status',            kind: COLUMN.TEXT },
  { key: 'invoiceDate',           label: 'Invoice date',      kind: COLUMN.DATE },
  { key: 'grossTotal',            label: 'Recorded (gross)',  kind: COLUMN.MONEY },
  { key: 'matchBasis',            label: 'Matched on',        kind: COLUMN.TEXT },
]

function evaluateDuplicateInvoiceReferences(supplierInvoices, sourceStates) {
  const id = CHECK.DUPLICATE_INVOICE_REFERENCES
  const gated = gate(id, sourceStates)
  if (gated) return gated

  // Cancelled invoices are ignored — the duplicateInvoiceWarnings convention.
  const live = (supplierInvoices ?? []).filter(inv => inv && inv.status !== SI_STATUS.CANCELLED)
  const groups = new Map()
  let blankReferenceCount = 0
  for (const inv of live) {
    const ref = normaliseInvoiceRef(inv.supplierInvoiceNumber)
    if (!ref) { blankReferenceCount += 1; continue }
    const key = `${supplierKey(inv)}|${ref}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(inv)
  }
  const duplicateGroups = [...groups.entries()].filter(([, invs]) => invs.length > 1)
  const legacyGroupCount = duplicateGroups.filter(([key]) => key.startsWith('name:')).length

  const values = {
    assessedCount:        live.length - blankReferenceCount,
    blankReferenceCount,
    groupCount:           duplicateGroups.length,
    invoiceCount:         duplicateGroups.reduce((n, [, invs]) => n + invs.length, 0),
    legacyGroupCount,
  }

  const caveats = [
    'A match is the same supplier and the same supplier reference after trimming, lower-casing and removing ' +
    'whitespace. A supplier that reuses a reference across periods, or a cancelled-and-reissued invoice that ' +
    'was never cancelled, will match legitimately. Review the records before acting.',
    NOT_WRONGDOING_CAVEAT,
  ]
  if (blankReferenceCount > 0) {
    caveats.push(`${plural(blankReferenceCount, 'invoice has', 'invoices have')} no supplier reference and cannot be compared.`)
  }
  if (legacyGroupCount > 0) {
    caveats.push(
      'Invoices without a linked supplier contact (raised before the Contacts module) are matched on their frozen ' +
      'supplier name, which is less reliable than a supplier id. Invoices with different supplier ids are never ' +
      'combined because their names match.',
    )
  }

  if (live.length === 0) {
    return check(id, SHIELD_STATE.NEEDS_DATA, {
      reason: NEEDS_DATA_REASON.NO_RECORDS,
      headline: 'No supplier invoices recorded yet',
      explanation: 'Duplicate references can only be compared once this project has supplier invoices.',
      values,
    })
  }
  if (values.assessedCount === 0) {
    return check(id, SHIELD_STATE.NEEDS_DATA, {
      reason: NEEDS_DATA_REASON.REFERENCES_MISSING,
      headline: 'No supplier invoice carries a supplier reference',
      explanation: 'Every non-cancelled invoice has a blank supplier reference, so none can be compared.',
      values,
      caveats,
    })
  }

  if (duplicateGroups.length > 0) {
    const evidence = duplicateGroups
      .flatMap(([key, invs], groupIndex) => invs.map(inv => ({
        id: inv.id,
        groupKey: key,
        groupIndex: groupIndex + 1,
        invoiceNumber: inv.invoiceNumber || '',
        supplierInvoiceNumber: inv.supplierInvoiceNumber || '',
        supplierId: inv.supplierId ?? null,
        supplierName: inv.supplierName || '',
        status: inv.status,
        statusLabel: siStatusLabel(inv.status),
        invoiceDate: inv.invoiceDate || '',
        grossTotal: Number.isFinite(Number(inv.grossTotal)) ? roundMoney(Number(inv.grossTotal)) : null,
        legacyNameMatch: !inv.supplierId,
        matchBasis: inv.supplierId ? 'Supplier id' : 'Supplier name (legacy)',
      })))
      .sort((a, b) => a.groupIndex - b.groupIndex
        || (a.invoiceDate || '').localeCompare(b.invoiceDate || '')
        || (a.invoiceNumber || '').localeCompare(b.invoiceNumber || ''))
    return check(id, SHIELD_STATE.FINDING, {
      headline: `${plural(values.invoiceCount, 'invoice shares', 'invoices share')} a supplier reference in ` +
        `${plural(duplicateGroups.length, 'group', 'groups')} — potential duplicates to review`,
      explanation:
        'Non-cancelled supplier invoices for the same supplier carry the same supplier reference. Each group is ' +
        'listed with every invoice in it, its status, date and recorded gross total, so the records can be compared.',
      values,
      evidence,
      evidenceColumns: DUPLICATE_COLUMNS,
      caveats,
    })
  }

  return check(id, SHIELD_STATE.NO_ISSUE, {
    headline: `No repeated supplier reference across ${plural(values.assessedCount, 'invoice', 'invoices')}`,
    explanation: 'Every non-cancelled supplier invoice with a supplier reference is the only one for its supplier with that reference.',
    values,
    caveats: caveats.filter(c => c !== NOT_WRONGDOING_CAVEAT),
  })
}

// ── 2 · Supplier invoice integrity ───────────────────────────────────────────

export const INTEGRITY_ISSUE = {
  TOTALS_MISMATCH:   'totals_mismatch',
  MISSING_COST_CODE: 'missing_cost_code',
  MALFORMED:         'malformed',
}

const INTEGRITY_ISSUE_LABELS = {
  [INTEGRITY_ISSUE.TOTALS_MISMATCH]:   'Stored total differs from its lines',
  [INTEGRITY_ISSUE.MISSING_COST_CODE]: 'Line without a cost code',
  [INTEGRITY_ISSUE.MALFORMED]:         'Cannot be verified (malformed)',
}

// The header money fields a stored invoice must reproduce from its own lines
// and retention, in the order the message names the most meaningful first.
// `invoiceTotals` is the one authoritative composition (lib/supplierInvoices.js):
// it sums the STORED per-line amounts and gstAmounts, so this comparison never
// re-derives GST from an amount and cannot raise the one-cent create artefact.
const INTEGRITY_FIELDS = [
  ['payableTotal',   'payable total'],
  ['payableGst',     'payable GST'],
  ['subtotal',       'subtotal'],
  ['gstTotal',       'GST total'],
  ['grossTotal',     'gross total'],
  ['retention',      'retention'],
  ['retentionGst',   'retention GST'],
  ['retentionTotal', 'retention total'],
  ['net',            'net'],
]

const INTEGRITY_COLUMNS = [
  { key: 'invoiceNumber', label: 'Invoice',    kind: COLUMN.TEXT },
  { key: 'supplierName',  label: 'Supplier',   kind: COLUMN.TEXT },
  { key: 'statusLabel',   label: 'Status',     kind: COLUMN.TEXT },
  { key: 'issueLabel',    label: 'Issue',      kind: COLUMN.TEXT },
  { key: 'detail',        label: 'Detail',     kind: COLUMN.TEXT },
  { key: 'stored',        label: 'Stored',     kind: COLUMN.MONEY },
  { key: 'fromLines',     label: 'From lines', kind: COLUMN.MONEY },
  { key: 'difference',    label: 'Difference', kind: COLUMN.MONEY },
]

const finite = (v) => Number.isFinite(Number(v))

// Why a stored invoice cannot be verified at all, or null when it can.
function malformedReason(inv) {
  if (!Array.isArray(inv.lineItems) || inv.lineItems.length === 0) return 'no readable line items'
  const badLine = inv.lineItems.findIndex(li => !li || typeof li !== 'object' || !finite(li.amount))
  if (badLine !== -1) return `line ${badLine + 1} has no numeric amount`
  if (!finite(inv.retention)) return 'retention is not a number'
  const badField = INTEGRITY_FIELDS.find(([key]) => !finite(inv[key]))
  if (badField) return `stored ${badField[1]} is missing`
  return null
}

function evaluateInvoiceIntegrity(supplierInvoices, sourceStates) {
  const id = CHECK.INVOICE_INTEGRITY
  const gated = gate(id, sourceStates)
  if (gated) return gated

  // Only invoices that COUNT financially are assessed (posted, plus the
  // deprecated `paid` that SI_COUNTING_STATUSES deliberately retains — ADR-24).
  // Drafts are still being authored and approved-but-unposted invoices feed no
  // figure yet, so neither is a financial integrity failure.
  const counting = (supplierInvoices ?? []).filter(inv => inv && SI_COUNTING_STATUSES.includes(inv.status))
  const evidence = []
  let mismatchCount = 0
  let missingCostCodeCount = 0
  let malformedCount = 0

  for (const inv of counting) {
    const base = {
      invoiceNumber: inv.invoiceNumber || '',
      supplierName: inv.supplierName || '',
      status: inv.status,
      statusLabel: siStatusLabel(inv.status),
      source: inv.source ?? null,
    }
    const malformed = malformedReason(inv)
    if (malformed) {
      malformedCount += 1
      evidence.push({
        ...base, id: `${inv.id}:malformed`, invoiceId: inv.id,
        issue: INTEGRITY_ISSUE.MALFORMED, issueLabel: INTEGRITY_ISSUE_LABELS[INTEGRITY_ISSUE.MALFORMED],
        detail: malformed, stored: null, fromLines: null, difference: null,
      })
      continue
    }
    const recomputed = invoiceTotals(inv.lineItems, inv.retention)
    const drift = INTEGRITY_FIELDS.find(([key]) => toCents(inv[key]) !== toCents(recomputed[key]))
    if (drift) {
      const [key, label] = drift
      const stored = roundMoney(Number(inv[key]))
      mismatchCount += 1
      evidence.push({
        ...base, id: `${inv.id}:totals`, invoiceId: inv.id,
        issue: INTEGRITY_ISSUE.TOTALS_MISMATCH, issueLabel: INTEGRITY_ISSUE_LABELS[INTEGRITY_ISSUE.TOTALS_MISMATCH],
        detail: label, field: key, stored, fromLines: recomputed[key],
        difference: roundMoney(stored - recomputed[key]),
      })
    }
    const uncoded = inv.lineItems.filter(li => !(typeof li.costCodeId === 'string' && li.costCodeId.length > 0))
    if (uncoded.length > 0) {
      missingCostCodeCount += 1
      // Σ of the stored line amounts on the uncoded lines — the same sum
      // invoicedByCostCode would have attributed, had the lines carried a code.
      const uncodedAmount = roundMoney(uncoded.reduce((sum, li) => sum + (Number(li.amount) || 0), 0))
      evidence.push({
        ...base, id: `${inv.id}:costcode`, invoiceId: inv.id,
        issue: INTEGRITY_ISSUE.MISSING_COST_CODE, issueLabel: INTEGRITY_ISSUE_LABELS[INTEGRITY_ISSUE.MISSING_COST_CODE],
        detail: `${uncoded.length} of ${inv.lineItems.length} ${inv.lineItems.length === 1 ? 'line' : 'lines'} (ex-GST amount shown)`,
        stored: uncodedAmount, fromLines: null, difference: null,
      })
    }
  }
  evidence.sort((a, b) => (a.invoiceNumber || '').localeCompare(b.invoiceNumber || '') || a.issue.localeCompare(b.issue))

  const values = {
    assessedCount: counting.length,
    mismatchCount,
    missingCostCodeCount,
    malformedCount,
    cleanCount: counting.length - new Set(evidence.map(r => r.invoiceId)).size,
  }
  const caveats = [
    'Only posted supplier invoices are assessed: drafts are still being authored and approved-but-unposted ' +
    'invoices feed no figure yet. Figures are compared in whole cents against the invoice\'s own stored lines ' +
    'and retention through the same invoiceTotals composition the app writes with — no GST is re-derived.',
    NOT_WRONGDOING_CAVEAT,
  ]
  if (malformedCount > 0) {
    caveats.push(
      `${plural(malformedCount, 'invoice', 'invoices')} could not be verified because a stored amount, total or line is ` +
      'missing or non-numeric. That is insufficient source data, not a verified mismatch.',
    )
  }

  if (counting.length === 0) {
    return check(id, SHIELD_STATE.NEEDS_DATA, {
      reason: NEEDS_DATA_REASON.NO_RECORDS,
      headline: 'No posted supplier invoices yet',
      explanation: 'Integrity is checked on posted supplier invoices, because those are the records that feed Invoiced, Actual and Remaining Payable.',
      values,
    })
  }

  if (mismatchCount > 0 || missingCostCodeCount > 0) {
    const parts = []
    if (mismatchCount > 0) parts.push(`${plural(mismatchCount, 'invoice', 'invoices')} with a stored total that differs from its lines`)
    if (missingCostCodeCount > 0) parts.push(`${plural(missingCostCodeCount, 'invoice', 'invoices')} with a line that carries no cost code`)
    return check(id, SHIELD_STATE.FINDING, {
      headline: parts.join(' and '),
      explanation:
        'A stored header total that does not reproduce from the invoice\'s own lines means the payable side ' +
        '(headers) and the cost side (lines) disagree about the same invoice. A counted line with no cost code ' +
        'is payable but attributed to no cost code, so it is absent from Invoiced and Actual by cost code.',
      values,
      evidence,
      evidenceColumns: INTEGRITY_COLUMNS,
      caveats,
    })
  }

  if (malformedCount > 0) {
    return check(id, SHIELD_STATE.NEEDS_DATA, {
      reason: NEEDS_DATA_REASON.MALFORMED_RECORDS,
      headline: `${plural(malformedCount, 'posted invoice', 'posted invoices')} cannot be verified`,
      explanation: 'No verified mismatch was found, but the listed invoices carry missing or non-numeric stored data and were not assessed.',
      values,
      evidence,
      evidenceColumns: INTEGRITY_COLUMNS,
      caveats,
    })
  }

  return check(id, SHIELD_STATE.NO_ISSUE, {
    headline: `All ${plural(counting.length, 'posted invoice reconciles', 'posted invoices reconcile')} to their lines, with a cost code on every line`,
    explanation: 'Every stored header total reproduces from the invoice\'s own lines and retention in whole cents, and every counted line carries a cost code.',
    values,
    caveats: [caveats[0]],
  })
}

// ── 3 · Purchase order over-invoicing exposure ───────────────────────────────

const OVER_INVOICING_COLUMNS = [
  { key: 'poNumber',                label: 'Purchase order',           kind: COLUMN.TEXT },
  { key: 'poStatusLabel',           label: 'PO status',                kind: COLUMN.TEXT },
  { key: 'levelLabel',              label: 'Level',                    kind: COLUMN.TEXT },
  { key: 'description',             label: 'Line',                     kind: COLUMN.TEXT },
  { key: 'originalAmount',          label: 'Original PO value (ex-GST)', kind: COLUMN.MONEY },
  { key: 'appliedAdjustment',       label: 'Applied SVs (ex-GST)',     kind: COLUMN.MONEY },
  { key: 'poAmount',                label: 'Revised PO value (ex-GST)', kind: COLUMN.MONEY },
  { key: 'invoiced',                label: 'Posted invoiced (ex-GST)', kind: COLUMN.MONEY },
  { key: 'excess',                  label: 'Excess',                   kind: COLUMN.MONEY },
  { key: 'approvedVariationsTotal', label: 'Approved SVs on PO',       kind: COLUMN.MONEY },
  { key: 'approvedVariationCount',  label: 'SVs',                      kind: COLUMN.INT },
  { key: 'appliedVariationCount',   label: 'Applied SVs',              kind: COLUMN.INT },
]

function evaluatePoOverInvoicing(purchaseOrders, supplierInvoices, variations, sourceStates) {
  const id = CHECK.PO_OVER_INVOICING
  const gated = gate(id, sourceStates)
  if (gated) return gated

  const pos = (purchaseOrders ?? []).filter(Boolean)
  const byLine = postedInvoicedByPoLine(supplierInvoices ?? [])
  const byPo = postedInvoicedByPo(supplierInvoices ?? [])
  const invoicedPoIds = Object.keys(byPo)

  // Approved SUPPLIER variations that reference the PO — context columns. The
  // total is the existing signed selector applied to the PO's own variations;
  // it is never deducted from anything. The APPLIED ones (ADR-62) are a
  // different matter: their existing-line amounts are inside the REVISED PO
  // line value through the one shared adjustment map, so the comparison below
  // is against the revised ceiling, exactly as Remaining Committed nets it.
  const variationsForPo = (poId) =>
    (variations ?? []).filter(v => v && v.variationType === VARIATION_TYPE.SUPPLIER
      && VARIATION_APPROVED_STATUSES.includes(v.status) && v.poId === poId)
  const adjustments = appliedSupplierVariationAdjustments(variations ?? [], pos)
  const revisedByPo = revisedCommitmentByPoLine(pos, adjustments.byPoLine)

  const evidence = []
  let lineExcessTotal = 0
  let poExcessTotal = 0
  const posWithExcess = new Set()

  for (const po of pos) {
    const forPo = byLine[po.id]
    if (!forPo) continue
    const svs = variationsForPo(po.id)
    const context = {
      approvedVariationCount: svs.length,
      approvedVariationsTotal: svs.length > 0 ? approvedSupplierVariationsTotal(svs) : null,
      appliedVariationCount: svs.filter(isCommitmentApplied).length,
    }
    const revisedLines = revisedByPo[po.id] ?? {}
    const appliedOnPo = roundMoney(Object.values(revisedLines).reduce((s, r) => s + safeAmount(r.adjustment), 0))
    const base = { poId: po.id, poNumber: po.poNumber || '', poStatus: po.status, poStatusLabel: poStatusLabel(po.status), ...context }
    const poLines = Array.isArray(po.lineItems) ? po.lineItems : []

    for (const idx of Object.keys(forPo).map(Number).sort((a, b) => a - b)) {
      const invoiced = roundMoney(safeAmount(forPo[idx]))
      const poLine = poLines[idx]
      const originalValue = poLine ? roundMoney(safeAmount(poLine.lineTotal)) : 0
      const appliedAdjustment = poLine ? roundMoney(safeAmount(revisedLines[idx]?.adjustment)) : 0
      // The REVISED contractual ceiling (ADR-62) — original + applied variations.
      const lineValue = poLine ? roundMoney(originalValue + appliedAdjustment) : 0
      const excess = roundMoney(invoiced - lineValue)
      if (!isPositiveCents(excess)) continue
      lineExcessTotal = roundMoney(lineExcessTotal + excess)
      posWithExcess.add(po.id)
      evidence.push({
        ...base,
        id: `${po.id}:line:${idx}`,
        level: 'line',
        levelLabel: poLine ? `Line ${idx + 1}` : `Line ${idx + 1} (not on PO)`,
        poLineIndex: idx,
        description: poLine
          ? [poLine.costCodeName, poLine.description].filter(Boolean).join(' · ')
          : 'Invoice lines reference a PO line index that does not exist on this PO',
        originalAmount: originalValue,
        appliedAdjustment,
        poAmount: lineValue,
        invoiced,
        excess,
      })
    }

    const invoicedTotal = roundMoney(safeAmount(byPo[po.id]))
    const poOriginal = roundMoney(safeAmount(po.subtotal))
    const poSubtotal = roundMoney(poOriginal + appliedOnPo)
    const poExcess = roundMoney(invoicedTotal - poSubtotal)
    if (isPositiveCents(poExcess)) {
      poExcessTotal = roundMoney(poExcessTotal + poExcess)
      posWithExcess.add(po.id)
      evidence.push({
        ...base,
        id: `${po.id}:po`,
        level: 'po',
        levelLabel: 'PO total',
        poLineIndex: null,
        description: 'Posted invoiced total against the PO subtotal (revised by applied variations)',
        originalAmount: poOriginal,
        appliedAdjustment: appliedOnPo,
        poAmount: poSubtotal,
        invoiced: invoicedTotal,
        excess: poExcess,
      })
    }
  }
  // VARIATION-ORIGIN invoice lines (M3-B2, ADR-63): recognised against their
  // own ceiling — the committed new-scope line's approved amount — never
  // against a PO line or the PO subtotal (postedInvoicedByPo excludes them).
  // A posted line naming a variation line that is NOT a committed positive
  // new-scope line has no ceiling at all and is listed in full.
  const byVariationLine = postedInvoicedByVariationLine(supplierInvoices ?? [])
  const variationById = new Map((variations ?? []).filter(v => v?.id).map(v => [v.id, v]))
  let variationLineExcessTotal = 0
  for (const [variationId, lines] of Object.entries(byVariationLine)) {
    const v = variationById.get(variationId) ?? null
    const committed = adjustments.newScopeLines[variationId] ?? {}
    for (const idxKey of Object.keys(lines).map(Number).sort((a, b) => a - b)) {
      const invoiced = roundMoney(safeAmount(lines[idxKey]))
      const ceiling = roundMoney(safeAmount(committed[idxKey]?.amount))
      const excess = roundMoney(invoiced - ceiling)
      if (!isPositiveCents(excess)) continue
      variationLineExcessTotal = roundMoney(variationLineExcessTotal + excess)
      const poId = v?.poId ?? committed[idxKey]?.poId ?? null
      const po = poId ? pos.find(p => p.id === poId) : null
      if (poId) posWithExcess.add(poId)
      const vLine = (v?.lineItems ?? [])[idxKey]
      evidence.push({
        poId, poNumber: po?.poNumber || v?.poNumber || '', poStatus: po?.status ?? null, poStatusLabel: po ? poStatusLabel(po.status) : 'Not found',
        approvedVariationCount: null, approvedVariationsTotal: null, appliedVariationCount: null,
        id: `${variationId}:varline:${idxKey}`,
        level: 'variationLine',
        levelLabel: `${v?.variationNumber || variationId} line ${idxKey + 1}`,
        poLineIndex: null, variationId, variationLineIndex: idxKey,
        description: committed[idxKey]
          ? [committed[idxKey].costCodeName, committed[idxKey].description].filter(Boolean).join(' · ')
          : (vLine ? 'Invoice lines reference a variation line that is not committed, claimable new scope' : 'Invoice lines reference a variation line that does not exist'),
        originalAmount: 0,
        appliedAdjustment: ceiling,
        poAmount: ceiling,
        invoiced,
        excess,
      })
    }
  }
  const variationLineInvoiceCount = Object.values(byVariationLine).reduce((n, lines) => n + Object.keys(lines).length, 0)

  const levelOrder = { line: 0, variationLine: 1, po: 2 }
  evidence.sort((a, b) => (a.poNumber || '').localeCompare(b.poNumber || '')
    || (a.level === b.level ? (a.poLineIndex ?? a.variationLineIndex ?? -1) - (b.poLineIndex ?? b.variationLineIndex ?? -1) : levelOrder[a.level] - levelOrder[b.level]))

  const unresolvedPoIds = invoicedPoIds.filter(poId => !pos.some(po => po.id === poId))

  const values = {
    invoicedPoCount: invoicedPoIds.length,
    poCount: posWithExcess.size,
    lineRowCount: evidence.filter(r => r.level === 'line').length,
    poRowCount: evidence.filter(r => r.level === 'po').length,
    variationLineRowCount: evidence.filter(r => r.level === 'variationLine').length,
    lineExcessTotal,
    poExcessTotal,
    variationLineExcessTotal,
    variationLineInvoiceCount,
    unresolvedPoCount: unresolvedPoIds.length,
  }

  const caveats = [
    'This is commercial exposure, not necessarily an error: an approved supplier variation not yet applied, a credit ' +
    'note still to be raised, or an agreed contractual change may explain it. Supplier variations APPLIED to the PO ' +
    'commitment are already inside the revised PO value compared here; approved variations not applied are shown ' +
    'for context and are never deducted. A human review decides.',
    'Line excess and PO-level excess are reported separately and must not be added together: the PO-level figure ' +
    'is net of lines invoiced below their value, so the same excess can appear in both.',
    'Remaining Committed floors each PO line at zero, so an over-invoiced line shows no negative commitment on the ' +
    'Budget or Forecast pages — this is the only place it is listed.',
    'Invoice lines raised from a new-scope variation line (ADR-63) are compared with that variation line’s approved ' +
    'amount, never with a PO line or the PO subtotal; a line whose variation line is not committed, claimable new ' +
    'scope has no ceiling and is listed in full.',
    NOT_WRONGDOING_CAVEAT,
  ]
  if (unresolvedPoIds.length > 0) {
    caveats.push(
      `${plural(unresolvedPoIds.length, 'purchase order', 'purchase orders')} referenced by posted invoices could not be found ` +
      'in this project and could not be compared.',
    )
  }

  if (invoicedPoIds.length === 0 && variationLineInvoiceCount === 0) {
    return check(id, SHIELD_STATE.NEEDS_DATA, {
      reason: NEEDS_DATA_REASON.NO_RECORDS,
      headline: 'No posted supplier invoice references a purchase order yet',
      explanation: 'Over-invoicing can only be assessed once posted supplier invoices exist against purchase orders.',
      values,
    })
  }

  if (evidence.length > 0) {
    return check(id, SHIELD_STATE.FINDING, {
      headline: `${plural(posWithExcess.size, 'purchase order is', 'purchase orders are')} invoiced beyond their value — ` +
        `${plural(values.lineRowCount, 'line', 'lines')}, ${plural(values.poRowCount, 'PO total', 'PO totals')}` +
        (values.variationLineRowCount > 0 ? `, ${plural(values.variationLineRowCount, 'variation line', 'variation lines')}` : ''),
      explanation:
        'Posted ex-GST invoiced-to-date per PO line (and per PO) exceeds the PO line value (or PO subtotal), or per ' +
        'new-scope variation line exceeds that line’s approved amount. Figures are the same postedInvoicedByPoLine / ' +
        'postedInvoicedByPo / postedInvoicedByVariationLine selectors that mature Committed, compared in whole cents.',
      values,
      evidence,
      evidenceColumns: OVER_INVOICING_COLUMNS,
      caveats,
    })
  }

  return check(id, SHIELD_STATE.NO_ISSUE, {
    headline: `No posted invoice exceeds its purchase order (${plural(invoicedPoIds.length, 'PO', 'POs')} invoiced)`,
    explanation: 'Posted ex-GST invoiced-to-date is within every PO line value and every PO subtotal, in whole cents.',
    values,
    caveats: unresolvedPoIds.length > 0 ? [caveats[caveats.length - 1]] : [],
  })
}

// ── 4 · Commitment records requiring reconciliation ──────────────────────────

export const STATE_CONFLICT = {
  UNCOMMITTED_PO_WITH_COST: 'uncommitted_po_with_cost',
  CLOSED_PO_WITH_OPEN_CLAIM: 'closed_po_with_open_claim',
  MULTIPLE_OPEN_CLAIMS:      'multiple_open_claims',
  MULTIPLE_INVOICES_PER_CLAIM: 'multiple_invoices_per_claim',
  // E · ADR-55 — one PO line recognised through BOTH paths at once: a posted
  //     direct invoice AND an approved claim no posted claim-sourced invoice
  //     has superseded. Actual counts both; nothing in the records can say
  //     which is the duplicate, so the line is listed for reconciliation.
  MIXED_MODE_PO_LINE:        'mixed_mode_po_line',
  // F · ADR-62 — an approved supplier variation APPLIED to its PO commitment
  //     whose line could not be incorporated: the PO is missing or no longer
  //     sent/closed, the PO line index does not exist, the line's cost code
  //     disagrees with the PO line, the amount is not a number, or the applied
  //     adjustments drive a PO line's revised value negative. The amount stays
  //     in unapplied exposure; nothing is counted against another line.
  VARIATION_NOT_INCORPORATED: 'variation_not_incorporated',
  // G · ADR-62 — recognition on a PO line (approved claims not yet superseded
  //     + posted invoices, the exact ADR-55 nets) exceeds the line's REVISED
  //     contractual value (original + applied variations). Arises when a
  //     negative variation lowers the ceiling below what was already
  //     recognised, or when a claim was approved above the line before the
  //     variation that covers it was applied. Listed only when approved CLAIM
  //     recognition takes part (an invoice-only overrun is check 3's);
  //     Remaining Committed floors the line at 0, so this is the only list.
  CLAIM_ABOVE_REVISED_LINE:   'claim_above_revised_line',
  // H · ADR-63 — a claim line that names a VARIATION source which does not, or
  //     no longer does, back it: variation missing / not approved / on another
  //     PO / not applied / new scope not committed, line index missing, not
  //     positive new scope, cost code or ceiling snapshot differing — or a
  //     claim whose source-line identities are malformed or duplicated (the
  //     shape a pre-M3-B2 client's draft edit would write). The certified
  //     amount stays in Actual where the claim put it and nets no commitment
  //     line; nothing is re-attributed.
  INVALID_CLAIM_SOURCE_LINE:  'invalid_claim_source_line',
}

const STATE_CONFLICT_LABELS = {
  [STATE_CONFLICT.UNCOMMITTED_PO_WITH_COST]:   'PO not committed, but cost counted against it',
  [STATE_CONFLICT.CLOSED_PO_WITH_OPEN_CLAIM]:  'PO closed or cancelled with an open claim',
  [STATE_CONFLICT.MULTIPLE_OPEN_CLAIMS]:       'More than one open claim on the PO',
  [STATE_CONFLICT.MULTIPLE_INVOICES_PER_CLAIM]: 'More than one active invoice for the claim',
  [STATE_CONFLICT.MIXED_MODE_PO_LINE]:         'PO line counted through both a direct invoice and an approved claim',
  [STATE_CONFLICT.VARIATION_NOT_INCORPORATED]: 'Applied supplier variation not incorporated in the PO commitment',
  [STATE_CONFLICT.CLAIM_ABOVE_REVISED_LINE]:   'Recognised claims exceed the revised line value',
  [STATE_CONFLICT.INVALID_CLAIM_SOURCE_LINE]:  'Claim line names an invalid or unresolved source line',
}

const STATE_CONFLICT_COLUMNS = [
  { key: 'conditionLabel',    label: 'Condition',       kind: COLUMN.TEXT },
  { key: 'poNumber',          label: 'Purchase order',  kind: COLUMN.TEXT },
  { key: 'poStatusLabel',     label: 'PO status',       kind: COLUMN.TEXT },
  { key: 'recordNumber',      label: 'Related record',  kind: COLUMN.TEXT },
  { key: 'recordStatusLabel', label: 'Record status',   kind: COLUMN.TEXT },
  { key: 'amount',            label: 'Amount (ex-GST)', kind: COLUMN.MONEY },
]

const money = (v) => (finite(v) ? roundMoney(Number(v)) : null)

function evaluateCommitmentStateConflicts(purchaseOrders, progressClaims, supplierInvoices, variations, sourceStates) {
  const id = CHECK.COMMITMENT_STATE_CONFLICTS
  const gated = gate(id, sourceStates)
  if (gated) return gated

  const pos = (purchaseOrders ?? []).filter(Boolean)
  const claims = (progressClaims ?? []).filter(Boolean)
  const invoices = (supplierInvoices ?? []).filter(Boolean)
  const poById = new Map(pos.map(po => [po.id, po]))
  const poRef = (poId, fallbackNumber) => {
    const po = poById.get(poId)
    return {
      poId: poId ?? null,
      poNumber: po?.poNumber || fallbackNumber || '',
      poStatus: po?.status ?? null,
      poStatusLabel: po ? poStatusLabel(po.status) : 'Not found',
    }
  }
  const evidence = []
  const counts = Object.fromEntries(Object.values(STATE_CONFLICT).map(k => [k, 0]))
  const push = (condition, row) => {
    counts[condition] += 1
    evidence.push({ condition, conditionLabel: STATE_CONFLICT_LABELS[condition], ...row })
  }

  // A · a PO that is not a commitment (draft, pending approval or cancelled)
  //     carrying a counting invoice or an approved claim.
  for (const po of pos) {
    if (PO_COMMITTED_STATUSES.includes(po.status)) continue
    for (const inv of invoices) {
      if (inv.poId !== po.id || !SI_COUNTING_STATUSES.includes(inv.status)) continue
      push(STATE_CONFLICT.UNCOMMITTED_PO_WITH_COST, {
        id: `${STATE_CONFLICT.UNCOMMITTED_PO_WITH_COST}:${po.id}:${inv.id}`, ...poRef(po.id),
        recordId: inv.id, recordKind: 'invoice', recordNumber: inv.invoiceNumber || '',
        recordStatus: inv.status, recordStatusLabel: siStatusLabel(inv.status), amount: money(inv.subtotal),
      })
    }
    for (const cl of claims) {
      if (cl.poId !== po.id || !CLAIM_APPROVED_STATUSES.includes(cl.status)) continue
      push(STATE_CONFLICT.UNCOMMITTED_PO_WITH_COST, {
        id: `${STATE_CONFLICT.UNCOMMITTED_PO_WITH_COST}:${po.id}:${cl.id}`, ...poRef(po.id),
        recordId: cl.id, recordKind: 'claim', recordNumber: cl.claimNumber || '',
        recordStatus: cl.status, recordStatusLabel: claimStatusLabel(cl.status), amount: money(cl.approvedSubtotal),
      })
    }
  }

  // B · a closed or cancelled PO with a claim still open.
  for (const po of pos) {
    if (po.status !== PO_STATUS.CLOSED && po.status !== PO_STATUS.CANCELLED) continue
    for (const cl of claims) {
      if (cl.poId !== po.id || !CLAIM_OPEN_STATUSES.includes(cl.status)) continue
      push(STATE_CONFLICT.CLOSED_PO_WITH_OPEN_CLAIM, {
        id: `${STATE_CONFLICT.CLOSED_PO_WITH_OPEN_CLAIM}:${po.id}:${cl.id}`, ...poRef(po.id),
        recordId: cl.id, recordKind: 'claim', recordNumber: cl.claimNumber || '',
        recordStatus: cl.status, recordStatusLabel: claimStatusLabel(cl.status), amount: money(cl.claimedSubtotal),
      })
    }
  }

  // C · more than one open claim on one PO (hasOpenClaim blocks this at create;
  //     rules cannot — Deferred Control 3).
  const openByPo = new Map()
  for (const cl of claims) {
    if (!cl.poId || !CLAIM_OPEN_STATUSES.includes(cl.status)) continue
    if (!openByPo.has(cl.poId)) openByPo.set(cl.poId, [])
    openByPo.get(cl.poId).push(cl)
  }
  for (const [poId, open] of openByPo) {
    if (open.length < 2) continue
    for (const cl of open) {
      push(STATE_CONFLICT.MULTIPLE_OPEN_CLAIMS, {
        id: `${STATE_CONFLICT.MULTIPLE_OPEN_CLAIMS}:${poId}:${cl.id}`, ...poRef(poId, cl.poNumber),
        recordId: cl.id, recordKind: 'claim', recordNumber: cl.claimNumber || '',
        recordStatus: cl.status, recordStatusLabel: claimStatusLabel(cl.status), amount: money(cl.claimedSubtotal),
      })
    }
  }

  // D · more than one non-cancelled invoice for one claim (claimHasActiveInvoice
  //     blocks this at create; rules cannot — Deferred Control 3).
  const invoicesByClaim = new Map()
  for (const inv of invoices) {
    if (!inv.progressClaimId || inv.status === SI_STATUS.CANCELLED) continue
    if (!invoicesByClaim.has(inv.progressClaimId)) invoicesByClaim.set(inv.progressClaimId, [])
    invoicesByClaim.get(inv.progressClaimId).push(inv)
  }
  for (const [claimId, invs] of invoicesByClaim) {
    if (invs.length < 2) continue
    const cl = claims.find(c => c.id === claimId)
    for (const inv of invs) {
      push(STATE_CONFLICT.MULTIPLE_INVOICES_PER_CLAIM, {
        id: `${STATE_CONFLICT.MULTIPLE_INVOICES_PER_CLAIM}:${claimId}:${inv.id}`, ...poRef(inv.poId, inv.poNumber),
        claimId, claimNumber: cl?.claimNumber || inv.claimNumber || '',
        recordId: inv.id, recordKind: 'invoice',
        recordNumber: `${inv.invoiceNumber || ''} (claim ${cl?.claimNumber || inv.claimNumber || claimId})`,
        recordStatus: inv.status, recordStatusLabel: siStatusLabel(inv.status), amount: money(inv.subtotal),
      })
    }
  }

  // E · one PO line carrying BOTH a posted direct invoice and an approved,
  //     not-yet-invoiced claim (ADR-55). The editors block new combinations
  //     (client-only — Deferred Control 34); this lists the ones that exist.
  //     Figures are the exact per-line maps Remaining Committed nets; `amount`
  //     is the overlap — the most that can be double-counted on the line.
  for (const row of mixedModePoLineConflicts({ purchaseOrders: pos, progressClaims: claims, supplierInvoices: invoices })) {
    push(STATE_CONFLICT.MIXED_MODE_PO_LINE, {
      id: `${STATE_CONFLICT.MIXED_MODE_PO_LINE}:${row.poId}:${row.poLineIndex}`, ...poRef(row.poId, row.poNumber),
      recordId: row.id, recordKind: 'poLine',
      recordNumber: `${row.lineLabel} — direct ${row.invoiceNumbers.join(', ') || '—'} · claim ${row.claimNumbers.join(', ') || '—'}`,
      recordStatus: null, recordStatusLabel: 'Both counted in Actual',
      amount: money(row.overlap),
      directInvoiced: money(row.directInvoiced), recognisedClaims: money(row.recognisedClaims),
      costCodeId: row.costCodeId, costCodeName: row.costCodeName,
    })
  }

  // F · applied supplier-variation lines that could not be incorporated
  //     (ADR-62) — the same exception rows the Budget / Forecast exposure
  //     figures keep OUT of Remaining Committed. Listed, never offset.
  const adjustments = appliedSupplierVariationAdjustments((variations ?? []).filter(Boolean), pos)
  for (const ex of adjustments.exceptions) {
    const lineLabel = ex.poLineIndex == null ? `line ${ex.lineIndex + 1}` : `PO line ${ex.poLineIndex + 1}`
    push(STATE_CONFLICT.VARIATION_NOT_INCORPORATED, {
      id: `${STATE_CONFLICT.VARIATION_NOT_INCORPORATED}:${ex.variationId ?? ex.poId}:${ex.lineIndex ?? 'po'}:${ex.poLineIndex ?? 'na'}`,
      ...poRef(ex.poId, ex.poNumber),
      recordId: ex.variationId, recordKind: ex.kind === 'negative_revised_line' ? 'poLine' : 'variation',
      recordNumber: ex.kind === 'negative_revised_line'
        ? `${ex.poNumber || ex.poId} ${lineLabel} — revised value below zero`
        : `${ex.variationNumber || ex.variationId} ${lineLabel} — ${ex.issueLabel}`,
      recordStatus: ex.issue, recordStatusLabel: ex.issueLabel,
      amount: money(ex.amount),
      issue: ex.issue, variationNumber: ex.variationNumber, poLineIndex: ex.poLineIndex, lineIndex: ex.lineIndex,
      costCodeId: ex.costCodeId, costCodeName: ex.costCodeName,
    })
  }

  // G · recognition above the REVISED line value where approved claims take
  //     part (ADR-62 Correction D). recognised = approved claim value not yet
  //     superseded by a posted claim-sourced invoice + posted invoices on the
  //     line — the ADR-55 hand-over, so a claim and its replacement invoice are
  //     never both counted. Credit notes carry no PO line index (ADR-31) and
  //     do not reduce this figure. Claim recognition and posted invoicing are
  //     carried as separate columns beside the revised value.
  const revisedByPo = revisedCommitmentByPoLine(pos, adjustments.byPoLine)
  const supersededClaims = invoicedClaimIds(invoices)
  const recognisedClaims = recognisedClaimsByPoLine(claims, supersededClaims)
  const postedByLine = postedInvoicedByPoLine(invoices)
  for (const po of pos) {
    const lines = revisedByPo[po.id]
    if (!lines) continue
    for (const idxKey of Object.keys(lines)) {
      const idx = Number(idxKey)
      const claimsOnLine = roundMoney(safeAmount(recognisedClaims[po.id]?.[idx]))
      if (!isPositiveCents(claimsOnLine)) continue
      const invoicedOnLine = roundMoney(safeAmount(postedByLine[po.id]?.[idx]))
      const recognised = roundMoney(claimsOnLine + invoicedOnLine)
      const { original, adjustment, revised } = lines[idx]
      const excess = roundMoney(recognised - revised)
      if (!isPositiveCents(excess)) continue
      const li = (po.lineItems ?? [])[idx] ?? {}
      const claimNumbers = [...new Set(claims
        .filter(cl => cl.poId === po.id && CLAIM_APPROVED_STATUSES.includes(cl.status) && !supersededClaims.has(cl.id)
          && (cl.lineItems ?? []).some(l => l.poLineIndex === idx && isPositiveCents(safeAmount(l.approvedThisPeriod))))
        .map(cl => cl.claimNumber || cl.id))]
      const invoiceNumbers = [...new Set(invoices
        .filter(inv => inv.poId === po.id && SI_COUNTING_STATUSES.includes(inv.status)
          && (inv.lineItems ?? []).some(l => l.poLineIndex === idx && isPositiveCents(safeAmount(l.amount))))
        .map(inv => inv.invoiceNumber || inv.id))]
      push(STATE_CONFLICT.CLAIM_ABOVE_REVISED_LINE, {
        id: `${STATE_CONFLICT.CLAIM_ABOVE_REVISED_LINE}:${po.id}:${idx}`, ...poRef(po.id, po.poNumber),
        recordId: `${po.id}:${idx}`, recordKind: 'poLine',
        recordNumber: `Line ${idx + 1} — claims ${claimNumbers.join(', ') || '—'} · posted ${invoiceNumbers.join(', ') || '—'}`,
        recordStatus: null, recordStatusLabel: adjustment < 0 ? 'Recognised above the line as reduced by a negative variation' : 'Recognised above the revised line value',
        amount: excess,
        poLineIndex: idx, originalAmount: original, appliedAdjustment: adjustment, revisedLineValue: revised,
        recognisedClaims: claimsOnLine, postedInvoiced: invoicedOnLine, recognised,
        claimNumbers, invoiceNumbers,
        costCodeId: li.costCodeId || '', costCodeName: li.costCodeName || '',
      })
    }
  }

  // G (variation lines, ADR-63) · recognition on a committed new-scope line
  //     (approved claims not yet superseded + posted invoices on THAT variation
  //     line — the ADR-55 hand-over counted once) above the line's approved
  //     amount. The one combined composer (lib/commitment.js) supplies both
  //     maps and the committed lines.
  const rc = remainingCommitment({ purchaseOrders: pos, progressClaims: claims, supplierInvoices: invoices, variations: (variations ?? []).filter(Boolean) })
  for (const [variationId, lines] of Object.entries(rc.adjustments.newScopeLines)) {
    for (const idxKey of Object.keys(lines)) {
      const idx = Number(idxKey)
      const claimsOnLine = roundMoney(safeAmount(rc.recByVarLine[variationId]?.[idx]))
      if (!isPositiveCents(claimsOnLine)) continue
      const invoicedOnLine = roundMoney(safeAmount(rc.invByVarLine[variationId]?.[idx]))
      const recognised = roundMoney(claimsOnLine + invoicedOnLine)
      const ceiling = roundMoney(safeAmount(lines[idx].amount))
      const excess = roundMoney(recognised - ceiling)
      if (!isPositiveCents(excess)) continue
      const l = lines[idx]
      const claimNumbers = [...new Set(claims
        .filter(cl => CLAIM_APPROVED_STATUSES.includes(cl.status) && !supersededClaims.has(cl.id)
          && (cl.lineItems ?? []).some(x => x.variationId === variationId && x.variationLineIndex === idx && isPositiveCents(safeAmount(x.approvedThisPeriod))))
        .map(cl => cl.claimNumber || cl.id))]
      push(STATE_CONFLICT.CLAIM_ABOVE_REVISED_LINE, {
        id: `${STATE_CONFLICT.CLAIM_ABOVE_REVISED_LINE}:${variationId}:${idx}`, ...poRef(l.poId, l.poNumber),
        recordId: `${variationId}:${idx}`, recordKind: 'variationLine',
        recordNumber: `${l.variationNumber || variationId} line ${idx + 1} — claims ${claimNumbers.join(', ') || '—'}`,
        recordStatus: null, recordStatusLabel: 'Recognised above the new-scope line value',
        amount: excess,
        variationId, variationNumber: l.variationNumber, variationLineIndex: idx,
        originalAmount: 0, appliedAdjustment: ceiling, revisedLineValue: ceiling,
        recognisedClaims: claimsOnLine, postedInvoiced: invoicedOnLine, recognised,
        claimNumbers, costCodeId: l.costCodeId || '', costCodeName: l.costCodeName || '',
      })
    }
  }

  // H · claim lines whose VARIATION source is invalid or unresolved, and claims
  //     whose source-line identities are malformed or duplicated (ADR-63).
  //     Rejected claims are excluded; drafts and submitted claims are listed so
  //     a problem is visible before certification. Nothing is re-attributed.
  const variationById = new Map((variations ?? []).filter(v => v?.id).map(v => [v.id, v]))
  for (const row of variationOriginClaimLines(claims)) {
    const po = poById.get(row.poId) ?? null
    const issue = claimVariationLineIssue(row.line, { variation: variationById.get(row.line.variationId) ?? null, po, classify: classifyCommitmentLines })
    if (!issue) continue
    const cl = claims.find(c => c.id === row.claimId)
    push(STATE_CONFLICT.INVALID_CLAIM_SOURCE_LINE, {
      id: `${STATE_CONFLICT.INVALID_CLAIM_SOURCE_LINE}:${row.claimId}:${row.lineIndex}`, ...poRef(row.poId, cl?.poNumber),
      recordId: row.claimId, recordKind: 'claim',
      recordNumber: `${row.claimNumber || row.claimId} line ${row.lineIndex + 1} (${sourceLineLabel(row.line)}) — ${CLAIM_VARIATION_LINE_ISSUE_LABELS[issue] ?? issue}`,
      recordStatus: row.claimStatus, recordStatusLabel: claimStatusLabel(row.claimStatus),
      amount: money(CLAIM_APPROVED_STATUSES.includes(row.claimStatus) ? row.line.approvedThisPeriod : row.line.claimedThisPeriod),
      issue, variationId: row.line.variationId, variationLineIndex: row.line.variationLineIndex,
      costCodeId: row.line.costCodeId || '', costCodeName: row.line.costCodeName || '',
    })
  }
  for (const cl of claims) {
    if (cl.status === 'rejected') continue
    const identityError = sourceLineIdentityError(cl.lineItems, { poId: cl.poId })
    if (!identityError) continue
    push(STATE_CONFLICT.INVALID_CLAIM_SOURCE_LINE, {
      id: `${STATE_CONFLICT.INVALID_CLAIM_SOURCE_LINE}:${cl.id}:identity`, ...poRef(cl.poId, cl.poNumber),
      recordId: cl.id, recordKind: 'claim',
      recordNumber: `${cl.claimNumber || cl.id} — ${identityError}`,
      recordStatus: cl.status, recordStatusLabel: claimStatusLabel(cl.status),
      amount: money(CLAIM_APPROVED_STATUSES.includes(cl.status) ? cl.approvedSubtotal : cl.claimedSubtotal),
      issue: 'identity_malformed',
    })
  }

  const values = {
    poCount: pos.length,
    claimCount: claims.length,
    invoiceCount: invoices.length,
    conflictCount: evidence.length,
    byCondition: counts,
  }
  const caveats = [
    'These are records whose lifecycle states disagree with each other and need reconciling — not an inference ' +
    'of unauthorised conduct. PO and claim lifecycles are client-enforced (Firestore rules do not check them), so ' +
    'a PO can be closed or cancelled while claims or invoices against it remain.',
    'A PO line counted through both a direct invoice and an approved claim is listed with the overlapping amount. ' +
    'Actual and Remaining Committed are left exactly as the records say — nothing is reclassified or offset; ' +
    'reconcile by cancelling or crediting the record that should not stand.',
    'An applied supplier variation that could not be incorporated (missing or cancelled PO, a PO line that does not ' +
    'exist, a cost-code mismatch, or a revised PO line value below zero) keeps its amount in unapplied exposure — ' +
    'it is never counted against another PO line or cost code, and no source document is edited.',
    'Recognised claims above a revised PO line value are listed with claim recognition and posted invoicing as ' +
    'separate figures (a claim and its posted invoice are never both counted). Remaining Committed floors the line ' +
    'at zero, so this is the only place the overrun appears. Supplier credit notes carry no PO line index and do ' +
    'not reduce the recognition compared here; a negative variation never creates a credit note. Reconcile by ' +
    'reviewing the claim, the variation or the PO — nothing is adjusted automatically.',
    'A claim line raised from a new-scope variation line (ADR-63) is listed when its variation no longer backs it — ' +
    'missing, not approved, on another PO, not applied, new scope not committed, line not found, not positive new ' +
    'scope, or a differing cost code or ceiling — and a claim whose line identities are malformed or duplicated is ' +
    'listed whole. The certified amount stays in Actual exactly where the claim put it, nets no commitment line and is ' +
    'never re-attributed to a PO line; withdraw and re-raise the claim, or correct the variation.',
    NOT_WRONGDOING_CAVEAT,
  ]

  // An applied variation naming a PO the project does not hold is still a
  // finding on an otherwise empty register (condition F) — never "needs data".
  if (pos.length === 0 && claims.length === 0 && invoices.length === 0 && evidence.length === 0) {
    return check(id, SHIELD_STATE.NEEDS_DATA, {
      reason: NEEDS_DATA_REASON.NO_RECORDS,
      headline: 'No purchase orders, claims or supplier invoices yet',
      explanation: 'Lifecycle states can only be compared once the project has commitment records.',
      values,
    })
  }

  if (evidence.length > 0) {
    const named = Object.entries(counts).filter(([, n]) => n > 0)
      .map(([k, n]) => `${n} × ${STATE_CONFLICT_LABELS[k].toLowerCase()}`)
    return check(id, SHIELD_STATE.FINDING, {
      headline: `${plural(evidence.length, 'record needs', 'records need')} reconciling — ${named.join('; ')}`,
      explanation:
        'Each row is one related record whose status conflicts with its purchase order or claim: cost counted ' +
        'against an uncommitted PO, an open claim on a closed PO, more than one open claim per PO, more than ' +
        'one active invoice per claim, a PO line recognised through both a direct invoice and an approved claim, ' +
        'an applied supplier variation that could not be incorporated in its PO commitment, approved claim ' +
        'recognition above a PO line\u2019s revised contractual value or a new-scope variation line\u2019s approved amount, ' +
        'or a claim line whose variation source is invalid or unresolved.',
      values,
      evidence,
      evidenceColumns: STATE_CONFLICT_COLUMNS,
      caveats,
    })
  }

  return check(id, SHIELD_STATE.NO_ISSUE, {
    headline: 'Purchase order, claim and invoice states agree',
    explanation: 'No uncommitted PO carries counted cost, no closed or cancelled PO has an open claim, each PO has at most one open claim, each claim at most one active invoice, no PO line is counted through both a direct invoice and an approved claim, every applied supplier variation is incorporated in its PO commitment, no PO line\u2019s or new-scope variation line\u2019s recognised claims exceed its value, and every claim line names a valid source line.',
    values,
    caveats: [caveats[0]],
  })
}

// ── 5 · Existing financial exceptions (roll-up — reuse only) ─────────────────

export const EXCEPTION_KIND = {
  ALLOCATION:      'allocation',
  CREDIT_NOTE:     'credit_note',
  RELEASE:         'release',
  OVER_RELEASED:   'over_released',
  OVER_RECONCILED: 'over_reconciled',
}

const EXCEPTION_KIND_LABELS = {
  [EXCEPTION_KIND.ALLOCATION]:      'Payment allocation exception',
  [EXCEPTION_KIND.CREDIT_NOTE]:     'Credit note counting nothing',
  [EXCEPTION_KIND.RELEASE]:         'Retention release exception',
  [EXCEPTION_KIND.OVER_RELEASED]:   'Retention over-released',
  [EXCEPTION_KIND.OVER_RECONCILED]: 'Invoice over-reconciled',
}

const EXCEPTION_MODULES = {
  [EXCEPTION_KIND.ALLOCATION]:      'Supplier Payments',
  [EXCEPTION_KIND.CREDIT_NOTE]:     'Supplier Invoices · Credit Notes',
  [EXCEPTION_KIND.RELEASE]:         'Retention',
  [EXCEPTION_KIND.OVER_RELEASED]:   'Retention',
  [EXCEPTION_KIND.OVER_RECONCILED]: 'Supplier Payments',
}

const EXCEPTION_COLUMNS = [
  { key: 'moduleLabel',   label: 'Module',          kind: COLUMN.TEXT },
  { key: 'kindLabel',     label: 'Exception',       kind: COLUMN.TEXT },
  { key: 'recordNumber',  label: 'Record',          kind: COLUMN.TEXT },
  { key: 'invoiceNumber', label: 'Related invoice', kind: COLUMN.TEXT },
  { key: 'amount',        label: 'Amount (gross)',  kind: COLUMN.MONEY },
  { key: 'reference',     label: 'Reference (gross)', kind: COLUMN.MONEY },
  { key: 'reason',        label: 'Reason',          kind: COLUMN.TEXT },
]

function evaluateFinancialExceptions(sources, sourceStates) {
  const id = CHECK.FINANCIAL_EXCEPTIONS
  const gated = gate(id, sourceStates)
  if (gated) return gated

  const { supplierInvoices = [], supplierPayments = [], supplierCreditNotes = [], retentionReleases = [] } = sources
  const invoices = (supplierInvoices ?? []).filter(Boolean)
  const releasedMap = releasedByInvoiceId(retentionReleases)

  // Each list is the EXISTING selector's output, carried through. Credit-note
  // validity is creditTargetException's (through creditNoteExceptions on this
  // side, and through creditedByInvoice inside payablesSummary on the
  // over-reconciled side), so an invalid credit never reduces a valid liability.
  const allocation = allocationExceptions(supplierPayments, invoices)
  const credit = creditNoteExceptions(supplierCreditNotes, invoices)
  const release = releaseExceptions(retentionReleases, invoices)
  const overReleased = overReleasedRows(retentionInvoiceRows(invoices, retentionReleases))
  const payables = payablesSummary(invoices, supplierPayments, supplierCreditNotes, releasedMap)
  const overReconciled = overReconciledPayableRows(payables.rows)

  const row = (kind, extra) => ({
    kind, kindLabel: EXCEPTION_KIND_LABELS[kind], moduleLabel: EXCEPTION_MODULES[kind], ...extra,
  })
  const evidence = [
    ...allocation.map((e, i) => row(EXCEPTION_KIND.ALLOCATION, {
      id: `${EXCEPTION_KIND.ALLOCATION}:${e.paymentId}:${i}`, recordId: e.paymentId, recordNumber: e.paymentNumber || '',
      invoiceNumber: e.invoiceNumber || '', amount: e.allocatedAmount, reference: null, reason: e.reason,
    })),
    ...credit.map(e => row(EXCEPTION_KIND.CREDIT_NOTE, {
      id: `${EXCEPTION_KIND.CREDIT_NOTE}:${e.creditNoteId}`, recordId: e.creditNoteId, recordNumber: e.creditNumber || '',
      invoiceNumber: e.invoiceNumber || '', amount: e.grossTotal, reference: null, reason: e.reason,
    })),
    ...release.map(e => row(EXCEPTION_KIND.RELEASE, {
      id: `${EXCEPTION_KIND.RELEASE}:${e.releaseId}`, recordId: e.releaseId, recordNumber: e.releaseNumber || '',
      invoiceNumber: e.invoiceNumber || '', amount: e.releaseTotal, reference: null, reason: e.reason,
    })),
    ...overReleased.map(r => row(EXCEPTION_KIND.OVER_RELEASED, {
      id: `${EXCEPTION_KIND.OVER_RELEASED}:${r.id}`, recordId: r.id, recordNumber: r.invoiceNumber || '',
      invoiceNumber: r.invoiceNumber || '', amount: r.releasedTotal, reference: r.retentionTotal,
      reason: 'Posted retention releases exceed the retention withheld on the invoice (concurrent posting or a direct write).',
    })),
    ...overReconciled.map(r => row(EXCEPTION_KIND.OVER_RECONCILED, {
      id: `${EXCEPTION_KIND.OVER_RECONCILED}:${r.id}`, recordId: r.id, recordNumber: r.invoiceNumber || '',
      invoiceNumber: r.invoiceNumber || '', amount: r.remaining, reference: r.payableTotal,
      reason: 'Posted payment allocations plus valid posted credits exceed the invoice\'s payable basis — a negative remaining balance.',
    })),
  ]

  const counts = Object.fromEntries(Object.values(EXCEPTION_KIND).map(k => [k, evidence.filter(r => r.kind === k).length]))
  const values = {
    exceptionCount: evidence.length,
    byKind: counts,
    overReconciledTotal: payables.overReconciled,
    postedInvoiceCount: payables.count,
    postedPaymentCount: postedSupplierPayments(supplierPayments).length,
    postedCreditNoteCount: postedSupplierCreditNotes(supplierCreditNotes).length,
    postedReleaseCount: postedRetentionReleases(retentionReleases).length,
  }
  const assessable = values.postedInvoiceCount + values.postedPaymentCount + values.postedCreditNoteCount + values.postedReleaseCount

  const caveats = [
    'Every row is an exception the Supplier Payments, Supplier Invoices or Retention page already derives, listed ' +
    'here unchanged with its originating module. Each row is one underlying exception; a credit note that counts ' +
    'nothing cannot also over-reconcile its invoice, so no exception is counted twice.',
    'Nothing is reversed, clamped or reassigned: the cash, credit and release records stay exactly as recorded. ' +
    'Investigate on the originating page.',
    NOT_WRONGDOING_CAVEAT,
  ]

  if (assessable === 0) {
    return check(id, SHIELD_STATE.NEEDS_DATA, {
      reason: NEEDS_DATA_REASON.NO_RECORDS,
      headline: 'No posted payables records yet',
      explanation: 'Exceptions arise between posted supplier invoices, payments, credit notes and retention releases; none are posted yet.',
      values,
    })
  }

  if (evidence.length > 0) {
    const named = Object.entries(counts).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${EXCEPTION_KIND_LABELS[k].toLowerCase()}`)
    return check(id, SHIELD_STATE.FINDING, {
      headline: `${plural(evidence.length, 'existing exception', 'existing exceptions')} — ${named.join('; ')}`,
      explanation:
        'Exceptions already derived by the payables modules: payment allocations whose target is cancelled, ' +
        'unpayable or another supplier\'s; posted credit notes that fail the read-time validity gate and count ' +
        'nothing; retention releases whose target is gone or holds no retention; invoices over-released; and ' +
        'invoices settled beyond their payable basis.',
      values,
      evidence,
      evidenceColumns: EXCEPTION_COLUMNS,
      caveats,
    })
  }

  return check(id, SHIELD_STATE.NO_ISSUE, {
    headline: 'No payables exception on the posted records',
    explanation: 'Checked posted payment allocations, posted credit notes, posted retention releases and each posted invoice\'s reconciliation state.',
    values,
    caveats: [caveats[0]],
  })
}

// ── The evaluation ───────────────────────────────────────────────────────────
//
// `sources` holds the live arrays from the project-scoped hooks; `sourceStates`
// their loading/error flags in the Dashboard snapshot's shape; `now` is
// accepted for contract symmetry with evaluatePulse (no check reads the clock
// in this foundation); `currencyCode` is the project's RESOLVED currency,
// carried through so the page formats every amount in it.
export function evaluateShield({ sources = {}, sourceStates = {}, currencyCode } = {}) {
  // A subscription delivers documents, never holes — but the existing
  // selectors are not defensive against a null entry, so a malformed list is
  // normalised ONCE here rather than crashing the whole evaluation.
  const list = (v) => (Array.isArray(v) ? v.filter(Boolean) : [])
  const purchaseOrders      = list(sources.purchaseOrders)
  const progressClaims      = list(sources.progressClaims)
  const supplierInvoices    = list(sources.supplierInvoices)
  const supplierCreditNotes = list(sources.supplierCreditNotes)
  const supplierPayments    = list(sources.supplierPayments)
  const retentionReleases   = list(sources.retentionReleases)
  const variations          = list(sources.variations)

  const byId = {
    [CHECK.DUPLICATE_INVOICE_REFERENCES]: evaluateDuplicateInvoiceReferences(supplierInvoices, sourceStates),
    [CHECK.INVOICE_INTEGRITY]:            evaluateInvoiceIntegrity(supplierInvoices, sourceStates),
    [CHECK.PO_OVER_INVOICING]:            evaluatePoOverInvoicing(purchaseOrders, supplierInvoices, variations, sourceStates),
    [CHECK.COMMITMENT_STATE_CONFLICTS]:   evaluateCommitmentStateConflicts(purchaseOrders, progressClaims, supplierInvoices, variations, sourceStates),
    [CHECK.FINANCIAL_EXCEPTIONS]:         evaluateFinancialExceptions(
      { supplierInvoices, supplierPayments, supplierCreditNotes, retentionReleases }, sourceStates,
    ),
  }
  const checks = CHECK_ORDER.map(id => byId[id])

  return { currencyCode, checks, summary: summariseShield(checks) }
}

// Counts of checks in each state. COUNTS ONLY — never combined into a score,
// never weighted, never compared with a threshold.
export function summariseShield(checks) {
  const counts = {}
  for (const s of SHIELD_STATE_ORDER) counts[s] = 0
  for (const c of checks ?? []) {
    if (c && Object.prototype.hasOwnProperty.call(counts, c.state)) counts[c.state] += 1
  }
  return { counts, total: (checks ?? []).length }
}

// Checks grouped by state for the page, in CHECK_ORDER within a group.
export function groupChecks(checks) {
  const groups = {}
  for (const s of SHIELD_STATE_ORDER) groups[s] = []
  for (const c of checks ?? []) {
    if (c && groups[c.state]) groups[c.state].push(c)
  }
  return groups
}
