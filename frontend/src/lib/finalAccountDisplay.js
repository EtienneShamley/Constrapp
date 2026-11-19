import { formatCurrency, percent } from './formatters'
import { FIGURE_BASIS, BLOCKER } from './finalAccount'

// The text ONE Final Account figure renders as (ADR-24 display states):
// loading "—"; a missing amount "Unavailable" — never a zero; a figure that
// legitimately cannot be calculated (margin on non-positive revenue) "Not
// calculable"; a genuine zero a formatted zero. Formatting only.
export function figureText(value, basis, currencyCode, { nullable = false, pending = false } = {}) {
  if (pending) return '—'
  if (value === null || value === undefined) return nullable ? 'Not calculable' : 'Unavailable'
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'Unavailable'
  return basis === FIGURE_BASIS.PERCENT ? percent(value) : formatCurrency(value, currencyCode, { precise: true })
}

// ── View-specific wording ────────────────────────────────────────────────────
//
// The figure KEYS and their calculation metadata live in lib/finalAccount.js
// (which the trusted backend also runs). How a figure is LABELLED depends on
// what is being looked at, and that is decided here, in the presentation layer:
//
//   · REVISION — an APPROVED Final Account revision. The trusted backend
//     recomputed it with cost to complete at zero, so "Final cost", "Final
//     gross profit" and "Final margin" are accurate — and only here.
//   · DRAFT — a draft (or a withdrawn draft). It was prepared against the
//     readiness requirements but NOBODY has approved it and the server has not
//     recomputed it: its figures are PROPOSED, and are labelled so.
//   · LIVE — the current position computed from live records. Cost to complete
//     may be non-zero, so the same figures are FORECASTS and are labelled so;
//     nothing on the live view is called "final".
//
// Wording only: no amount is read, changed or derived here.

export const FIGURE_VIEW = { LIVE: 'live', DRAFT: 'draft', REVISION: 'revision' }

const SUPPLIER_VARIATIONS_REVISION =
  'Total approved value, ex-GST. Approval required every approved supplier variation to be applied to its purchase order or committed as new scope, so all of it is inside final cost'
const SUPPLIER_VARIATIONS_LIVE =
  'Total approved value, ex-GST. Only the part applied to a purchase order or committed as new scope is inside forecast final cost. Any approved value not yet applied is outside it and blocks approval'
const RECEIVABLES_OUTSTANDING =
  'Sum of the positive balances of issued invoices (invoice gross − receipts allocated to it). An over-allocated invoice does not reduce it, so it can exceed invoiced − received. Not cash'

const REVISION_TEXT = {
  approvedSupplierVariations: { note: SUPPLIER_VARIATIONS_REVISION },
  receivablesOutstanding:     { note: RECEIVABLES_OUTSTANDING },
}

const SUPPLIER_VARIATIONS_DRAFT =
  'Total approved value, ex-GST. When this draft was prepared every approved supplier variation was applied to its purchase order or committed as new scope, so all of it is inside the proposed final cost. Not confirmed until approval'

const DRAFT_TEXT = {
  finalContractSum:           { label: 'Proposed final contract sum' },
  remainingToInvoice:         { note: 'Proposed final contract sum − invoiced to client (negative = over-invoiced)' },
  approvedSupplierVariations: { note: SUPPLIER_VARIATIONS_DRAFT },
  costToComplete:             { note: 'Zero when this draft was prepared. Checked again at approval' },
  finalCost:                  { label: 'Proposed final cost', note: 'Actual cost + cost to complete, as prepared. Not final until approved' },
  varianceToBudget:           { note: 'Approved budget − proposed final cost (negative = over budget)' },
  finalProfit:                { label: 'Proposed final gross profit', note: 'Proposed final contract sum − proposed final cost' },
  finalMarginPct:             { label: 'Proposed final margin', note: 'Proposed final gross profit ÷ proposed final contract sum' },
  receivablesOutstanding:     { note: RECEIVABLES_OUTSTANDING },
}

const LIVE_TEXT = {
  finalContractSum:           { label: 'Adjusted contract sum' },
  remainingToInvoice:         { note: 'Adjusted contract sum − invoiced to client (negative = over-invoiced)' },
  approvedSupplierVariations: { note: SUPPLIER_VARIATIONS_LIVE },
  costToComplete:             { note: 'Remaining commitment + uncommitted cost to complete. Must be zero for approval' },
  finalCost:                  { label: 'Forecast final cost', note: 'Actual cost + cost to complete' },
  varianceToBudget:           { note: 'Approved budget − forecast final cost (negative = over budget)' },
  finalProfit:                { label: 'Forecast gross profit', note: 'Adjusted contract sum − forecast final cost' },
  finalMarginPct:             { label: 'Forecast margin', note: 'Forecast gross profit ÷ adjusted contract sum' },
  receivablesOutstanding:     { note: RECEIVABLES_OUTSTANDING },
}

// The label and note ONE figure definition shows in a given view.
export function figurePresentation(def, view = FIGURE_VIEW.REVISION) {
  const table = view === FIGURE_VIEW.LIVE ? LIVE_TEXT : view === FIGURE_VIEW.DRAFT ? DRAFT_TEXT : REVISION_TEXT
  const text = table[def.key] ?? {}
  return { label: text.label ?? def.label, note: text.note ?? def.note }
}

// The view a stored revision is shown in: only an APPROVED revision is final.
export const revisionView = (account) => (account?.status === 'approved' ? FIGURE_VIEW.REVISION : FIGURE_VIEW.DRAFT)

// ── Readiness wording ────────────────────────────────────────────────────────
//
// The readiness checklist is shown against LIVE records, where cost is a
// forecast. The requirement's code and logic stay in lib/finalAccount.js; the
// text the user reads for it is decided here.
const READINESS_TEXT = {
  [BLOCKER.UNAPPLIED_VARIATIONS]: {
    label: 'Every approved supplier variation is inside forecast final cost',
    fix: 'An approved supplier variation counts in forecast final cost only once it is applied to its purchase order or committed as new scope. At least one approved variation is not yet applied, so its value is outside forecast final cost. Apply or commit it on the Variations tab.',
  },
}

export function readinessPresentation(check) {
  const text = READINESS_TEXT[check.code] ?? {}
  return { label: text.label ?? check.label, fix: text.fix ?? check.fix }
}
