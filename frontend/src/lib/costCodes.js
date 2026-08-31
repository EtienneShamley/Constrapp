// ── Cost Code domain logic (ADR-39) ──────────────────────────────────────────
//
// Pure helpers for the company-wide cost-code taxonomy — THE commercial spine.
// No Firestore, no React.
//
// ⚠️ THE ID IS THE FINANCIAL KEY, NEVER THE CODE OR THE NAME.
// Every derivation in the app groups by `costCodeId`: Committed
// (lib/purchaseOrders.js), Actual (lib/progressClaims.js), Invoiced
// (lib/supplierInvoices.js), credits (lib/supplierCreditNotes.js), variation
// exposure (lib/variations.js), Forecast (lib/forecast.js) and the BOQ
// comparison (lib/boq.js). `code` and `name` are DISPLAY ONLY. Renaming a cost
// code, or deactivating it, therefore changes NO numeric financial output
// anywhere — proven in tests/unit/foundationEditInvariance.test.js.
//
// ⚠️ HISTORICAL SNAPSHOTS ARE NEVER BACKFILLED. Budget lines, PO lines, claim
// lines, supplier-invoice lines, credit-note lines, variation lines, BOQ items,
// forecast lines and cash-flow lines all freeze a `costCodeName` display string
// at write time. A rename does not — and must not — rewrite any of them: those
// documents record what the code was called when the commitment was made. The
// live/snapshot split is reconciled at READ TIME by `resolveCostCodeName`.

// Display string for a cost code — the ONE place `"03-100 — Concrete Slab"` is
// composed. lib/forecast.js and lib/boq.js build the identical string inline;
// this is that same convention, named.
export const costCodeDisplayName = (costCode) =>
  costCode ? `${costCode.code} — ${costCode.name}` : ''

// A cost code is ACTIVE unless it is explicitly deactivated.
//
// `isActive !== false` (never `=== true`) is deliberate and matches every
// existing filter in the app (ProjectTenders, RfiEditorModal,
// ActivityEditorModal, and the Contacts directory): a legacy document written
// before the flag existed has NO `isActive` key, and treating that as inactive
// would silently hide working cost codes from every picker.
export const isActiveCostCode = (costCode) => costCode?.isActive !== false

export const activeCostCodes = (costCodes) => (costCodes ?? []).filter(isActiveCostCode)

// THE read-time name resolution, matching lib/forecast.js and lib/boq.js
// exactly: prefer the LIVE cost code, fall back to the document's frozen
// snapshot, then to a visible placeholder.
//
// This is what lets a rename appear immediately on screens that still store an
// old snapshot, WITHOUT ever writing to those documents. The fallback chain
// matters in both directions: a code that has been renamed resolves live (the
// user sees the correction), while a code that has vanished entirely from the
// list still renders its snapshot rather than blanking a financial row.
export function resolveCostCodeName(costCodeId, costCodes, snapshotName) {
  const cc = (costCodes ?? []).find(c => c.id === costCodeId)
  if (cc) return costCodeDisplayName(cc)
  const snapshot = String(snapshotName ?? '').trim()
  return snapshot || 'Unknown cost code'
}

export const COST_CODE_MAX_LENGTH = 40
export const COST_CODE_NAME_MAX_LENGTH = 120
export const COST_CODE_CATEGORY_MAX_LENGTH = 80
export const COST_CODE_UNIT_MAX_LENGTH = 24

// Editor form values → the exact stored shape, applying the SAME normalisation
// `createCostCode` has always applied. `isActive` is NOT built here: it is
// owned by the separate Deactivate/Reactivate action, so a content edit can
// never flip a cost code's availability as a side effect.
export function buildCostCodeFields({ code, name, category, unit }) {
  return {
    code:     String(code ?? '').trim(),
    name:     String(name ?? '').trim(),
    category: String(category ?? '').trim(),
    unit:     String(unit ?? '').trim(),
  }
}

// Comparison key for duplicate detection: case-insensitive, and insensitive to
// internal as well as surrounding whitespace, so `"03 100"`, `"03  100"` and
// `"03 100 "` are one code.
export const normaliseCostCode = (code) =>
  String(code ?? '').trim().toLowerCase().replace(/\s+/g, ' ')

// Is `code` already used by a DIFFERENT cost code in this company?
//
// ⚠️ CLIENT-ENFORCED ONLY. Firestore rules have no list, query or count, so
// they cannot see sibling documents and cannot enforce this. Two concurrent
// writers can still create a duplicate, and a direct SDK call bypasses the
// check entirely. Nothing breaks when that happens — the document id remains
// the financial key and every total stays correct — but the list ordering
// becomes ambiguous. See docs/SECURITY.md → Deferred Control 28.
//
// `excludeId` is the record being edited: a cost code must never collide with
// itself, or saving an unrelated field (a unit, a category) would be blocked.
export function isDuplicateCostCode(costCodes, code, excludeId = null) {
  const candidate = normaliseCostCode(code)
  if (!candidate) return false
  return (costCodes ?? []).some(
    cc => cc.id !== excludeId && normaliseCostCode(cc.code) === candidate,
  )
}

// Returns null when valid, otherwise the first error message.
// `costCodes` + `excludeId` are optional — omit them to validate shape only.
export function validateCostCode(
  { code, name, category, unit },
  { costCodes = null, excludeId = null } = {},
) {
  const trimmedCode = String(code ?? '').trim()
  const trimmedName = String(name ?? '').trim()
  if (!trimmedCode) return 'Code is required.'
  if (trimmedCode.length > COST_CODE_MAX_LENGTH) {
    return `Code must be ${COST_CODE_MAX_LENGTH} characters or fewer.`
  }
  if (!trimmedName) return 'Name is required.'
  if (trimmedName.length > COST_CODE_NAME_MAX_LENGTH) {
    return `Name must be ${COST_CODE_NAME_MAX_LENGTH} characters or fewer.`
  }
  if (String(category ?? '').trim().length > COST_CODE_CATEGORY_MAX_LENGTH) {
    return `Category must be ${COST_CODE_CATEGORY_MAX_LENGTH} characters or fewer.`
  }
  if (String(unit ?? '').trim().length > COST_CODE_UNIT_MAX_LENGTH) {
    return `Unit must be ${COST_CODE_UNIT_MAX_LENGTH} characters or fewer.`
  }
  if (Array.isArray(costCodes) && isDuplicateCostCode(costCodes, trimmedCode, excludeId)) {
    return `Code “${trimmedCode}” is already in use.`
  }
  return null
}

// The Deactivate confirmation copy. Deliberately makes NO claim about how many
// records use the code: cost codes are COMPANY-WIDE while budget lines, POs and
// invoices are per-project, so any count this page could compute would cover
// one project and read as though it covered the company. Deactivation is never
// blocked, and it changes nothing that already exists — an inactive code keeps
// its budget line, its commitments and its actuals, and lib/forecast.js and
// lib/boq.js flag the row `isInactive` rather than dropping it.
export const COST_CODE_DEACTIVATE_NOTICE =
  'Deactivating removes this cost code from new budget lines and other new authoring across every project. ' +
  'Existing budget lines, orders, claims, invoices and variations keep it and stay readable, and no ' +
  'Budgeted, Committed, Actual, Invoiced, Forecast, Margin or Cash Flow figure changes. You can reactivate it at any time.'
