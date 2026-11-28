// ── The variation domain, as the trusted backend runs it (ADR-90) ────────────
//
// The ENTRY MODULE of functions/src/generated/variationCalc.js
// (scripts/build-variation-bundle.mjs). It defines nothing: it re-exports, from
// the modules the browser drafts and previews with, exactly what the three
// variation callables compose — so a variation is validated, numbered, derived,
// certified and applied to its commitment by ONE set of formulas in both
// places, under ONE calculation version (lib/supplierCalc.js, ADR-91).
//
// Add a name here only when functions/src/variations/ needs it. A formula
// never belongs in this file, and never in functions/src.

export { CALC_VERSION, CURRENT_CALC_VERSION, calcVersionOf } from './supplierCalc'
export { resolveProjectCurrency } from './currency'
export {
  VARIATION_TYPE, VARIATION_STATUS, VARIATION_COUNTER_ID,
  variationCalcVersion, isPoLinkedSupplierVariation, isCommitmentApplied, isScopeCommitted,
  shouldApplyOnApproval, commitmentApplyEligibility, COMMITMENT_APPLY_BLOCKER,
} from './variations'
export { VariationWriteError, storedRevision, transitionUpdate, applyCommitmentUpdate } from './variationActions'
export {
  VARIATION_PROCESSING_ROLES, CREATE_PROBLEM, APPROVABLE_STATUSES, ASSESSMENT_NOTES_MAX,
  createVariationRequestProblem, requestedCostCodeIds, buildVariationDraft,
  DRAFT_PROBLEM, updateVariationRequestProblem, buildVariationDraftUpdate, draftAlreadyHolds,
  approvedAmountsProblem, submittedSideProblem, approvedSideProblem, storedCostCodeIds, lineSources, withAuthoritativeNames,
  sameApproval, approvedHeaderSupported, approvalActorEvidence,
} from './variationProcessing'
