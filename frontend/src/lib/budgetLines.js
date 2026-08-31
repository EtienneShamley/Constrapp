// ── Budget Line domain logic (ADR-39) ────────────────────────────────────────
//
// Pure helpers for the project's Approved Budget allocations. No Firestore, no
// React.
//
// ⚠️ `budgeted` IS THE ONLY AUTHORITATIVE STORED FINANCIAL VALUE ON A BUDGET
// LINE. Committed, Claimed, Actual and Invoiced are ALL derived at read time
// from purchase orders, progress claims, supplier invoices and credit notes,
// keyed by `costCodeId` — nothing writes them onto a budget line. The stored
// `committed`, `actual` and `invoiced` keys are vestigial zeros written once at
// creation and read by no consumer in the app (see docs/DATA_MODEL.md); the
// Firestore rules update allow-list freezes them so an edit can never revive
// them as a second, stale source of truth.
//
// ⚠️ WHAT AN EDIT TO `budgeted` DOES AND DOES NOT MOVE (traced, and locked by
// tests/unit/foundationEditInvariance.test.js):
//
//   CHANGES   Budget tab   line Budgeted, line Remaining (budgeted − actual),
//                          header Budgeted, header Remaining, usage bar
//             Forecast     row Budgeted, Variance to Budget (budgeted − FFC),
//                          Remaining Budget Reference, the budget rollups
//             BOQ          Approved Budget total and BOQ-vs-budget variance
//             Tenders      variance to Approved Budget
//
//   UNCHANGED Forecast Final Cost — FFC = Actual + Remaining Committed +
//                          Uncommitted Cost to Complete (lib/forecast.js), none
//                          of which reads `budgeted`. A stored Uncommitted CTC
//                          that was once produced by the "Use remaining budget"
//                          action is a COPY made at that moment, never a live
//                          formula, so it is not recomputed.
//             Commercial   Current Contract Sum, Forecast Revenue, Forecast
//                          Gross Profit, Forecast Margin %, Original Planned
//                          Profit/Margin %, Margin Movement — computeMargin()
//                          reads only the baseline, variations and FFC.
//             Cash Flow    nothing in lib/cashFlow.js reads a budget line.
//             Budget tab   Committed, Claimed, Actual, Invoiced, Approved
//                          Supplier Variations, Commitment Exposure.
//
// In one sentence for the user: correcting a budget moves the VARIANCE, not the
// FORECAST.

// The ONLY keys `updateBudgetLine` may write (besides the audit stamps).
//
// `costCodeId` and `costCodeName` are absent BY DESIGN, and Firestore rules
// freeze both on update:
//   · Re-pointing a budget line to a different cost code would move an approved
//     budget between cost codes with no record that it moved — the cost-code
//     spine must not be rewritten under existing commitments and actuals.
//   · `costCodeName` is NOT re-snapshotted either, deliberately diverging from
//     the ADR-36 purchase-order editor. A PO line re-snapshots because its cost
//     code CAN change in the same edit; here it cannot, so re-snapshotting
//     would silently rewrite a line's recorded history during an edit the user
//     made only to a number. The Budget page instead resolves the CURRENT name
//     at read time (lib/costCodes.js → resolveCostCodeName), exactly as the
//     Forecast and BOQ pages already do.
export const BUDGET_LINE_EDITABLE_KEYS = ['budgeted', 'notes']

export const BUDGET_LINE_NOTES_MAX_LENGTH = 2000

// Editor form values → the exact stored shape.
//
// `budgeted` is coerced with `Number(...)`, NOT with `Number(x) || 0`: the
// create path's `|| 0` silently turns junk into a zero budget, which is a
// legitimate value and therefore indistinguishable from a real one. On EDIT the
// value must fail validation instead of quietly becoming 0, so a typo can never
// wipe an approved budget. `validateBudgetLine` rejects the resulting NaN.
export function buildBudgetLineFields({ budgeted, notes }) {
  return {
    budgeted: Number(budgeted),
    notes:    String(notes ?? '').trim(),
  }
}

// Returns null when valid, otherwise the error message.
//
// Zero is VALID and meaningful — a reviewed allocation of nothing, distinct
// from "not set" — matching the zero-is-a-value convention used throughout the
// financial modules. Negative is rejected here AND by Firestore rules: an
// approved budget is an allocation, and a negative allocation would flow
// straight into Remaining, Variance to Budget and the BOQ comparison as a
// silently wrong figure.
export function validateBudgetLine({ budgeted, notes }) {
  // Only a number or a numeric STRING may be coerced. The type guard is not
  // decoration: JavaScript coerces `[]` to 0 and `[5]` to 5, so without it an
  // array would validate as a perfectly ordinary budget. The editor can only
  // ever send a string, but the hook is a public surface and a zero budget is
  // indistinguishable from a real one once written.
  if (typeof budgeted !== 'number' && typeof budgeted !== 'string') {
    return 'Budgeted must be a number.'
  }
  const n = Number(budgeted)
  if (String(budgeted).trim() === '' || !Number.isFinite(n)) {
    return 'Budgeted must be a number.'
  }
  if (n < 0) return 'Budgeted cannot be negative.'
  if (String(notes ?? '').trim().length > BUDGET_LINE_NOTES_MAX_LENGTH) {
    return `Notes must be ${BUDGET_LINE_NOTES_MAX_LENGTH} characters or fewer.`
  }
  return null
}

// Stored line → editor form values. Numbers become strings ('0' stays '0', not
// ''), null/undefined become '' — the poLineToForm idiom from
// lib/purchaseOrders.js, so a budget line of 0 opens showing 0 rather than
// looking unset.
export function budgetLineToForm(line) {
  const l = line && typeof line === 'object' ? line : {}
  return {
    budgeted: l.budgeted === null || l.budgeted === undefined || l.budgeted === '' ? '' : String(l.budgeted),
    notes:    typeof l.notes === 'string' ? l.notes : '',
  }
}
