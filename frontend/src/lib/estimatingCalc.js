// ── The estimating domain, as ONE entry for the trusted backend (ADR-97) ─────
//
// `functions/src/generated/estimatingCalc.js` is generated from this file and
// everything it reaches (scripts/build-estimating-bundle.mjs). The
// `estimateOperation` callable imports that bundle, so every figure it stores
// comes from the SAME source the browser previews with.
export * from './estimating'
