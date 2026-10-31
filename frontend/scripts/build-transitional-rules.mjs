#!/usr/bin/env node
// ── ADR-62 / ADR-63 — the STAGE-1 transitional ruleset, derived, never hand-edited ──
//
// `firestore.rules` is the FINAL strict ruleset. Each release that requires a
// key the previously served bundle does not write needs a STAGE-1 ruleset that
// accepts BOTH the old write and the new one while the old bundle is still
// served — and nothing else may differ. For M3-B2 (ADR-63):
//
//   · variations branch (c): the FINAL file requires the ADR-62 applied pair
//     AND the ADR-63 scope pair on a PO-linked approve; the M3-B1 bundle writes
//     only the applied pair, so Stage 1 makes the scope pair optional (a
//     present pair must still be the caller's at server time; the PO must
//     still be sent/closed either way).
//   · progressClaims exactKeys: the FINAL file requires `variationLineCount`
//     at create; the M3-B1 bundle writes no such key, so Stage 1 leaves it
//     optional (absent reads 0 everywhere else in the block — unchanged).
//
// This script derives `firestore.transitional.rules` from `firestore.rules` by
// replacing EXACTLY the marked lines below, each of which must occur exactly
// once, so the two files are reviewable as a short diff and the transitional
// file can never drift from the final one. `tests/unit/rulesTransitional.test.js`
// fails the suite when the committed transitional file differs from what this
// script produces, and the emulator suite
// `tests/rules/variationsTransitional.rules.test.js` proves its behaviour
// against both client payloads.
//
//   node scripts/build-transitional-rules.mjs          # write the file
//   node scripts/build-transitional-rules.mjs --check  # exit 1 if it differs
//
// Deployment (DEPLOYMENT.md → M3-B2 release order) is Firebase-CLI driven:
// Stage 1 deploys the transitional file through `firebase.transitional.json`
// (an alternate --config that names it as the Firestore rules source); the
// FINAL stage deploys through the normal `firebase.json`. `firebase.json`
// keeps pointing at `firestore.rules` for the emulators.

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
export const FINAL_RULES_PATH = resolve(HERE, '../firestore.rules')
export const TRANSITIONAL_RULES_PATH = resolve(HERE, '../firestore.transitional.rules')

// Each FINAL line and its STAGE-1 replacement. Both carry an end-of-line marker
// so a reviewer can grep the live ruleset for which stage is published.
export const LINE_PAIRS = [
  {
    name: 'variations approve — the scope pair',
    final:
      "                              && appliedStamped(request.resource.data) && scopeStamped(request.resource.data))) // ADR-63 FINAL: BOTH pairs are REQUIRED on a PO-linked approve",
    transitional:
      "                              && appliedStamped(request.resource.data) && (scopeAbsent(request.resource.data) || scopeStamped(request.resource.data)))) // ADR-63 TRANSITIONAL (STAGE 1): the scope pair is OPTIONAL while the M3-B1 bundle is served",
  },
  {
    name: 'progressClaims exactKeys — variationLineCount',
    final:
      "            && request.resource.data.keys().hasAll(['claimNumber', 'status', 'poId', 'poNumber', 'supplierName', 'supplierId', 'claimRef', 'periodEnding', 'variationId', 'variationLineCount', 'lineItems', 'retention', 'claimedSubtotal', 'claimedGst', 'claimedTotal', 'approvedSubtotal', 'approvedGst', 'approvedTotal', 'notes', 'assessmentNotes', 'currency', 'revision', 'submittedAt', 'submittedBy', 'approvedAt', 'approvedBy', 'rejectedAt', 'rejectedBy', 'invoicedAt', 'externalRefs', 'createdAt', 'createdBy', 'updatedAt', 'updatedBy']); // ADR-63 FINAL: variationLineCount is REQUIRED at create",
    transitional:
      "            && request.resource.data.keys().hasAll(['claimNumber', 'status', 'poId', 'poNumber', 'supplierName', 'supplierId', 'claimRef', 'periodEnding', 'variationId', 'lineItems', 'retention', 'claimedSubtotal', 'claimedGst', 'claimedTotal', 'approvedSubtotal', 'approvedGst', 'approvedTotal', 'notes', 'assessmentNotes', 'currency', 'revision', 'submittedAt', 'submittedBy', 'approvedAt', 'approvedBy', 'rejectedAt', 'rejectedBy', 'invoicedAt', 'externalRefs', 'createdAt', 'createdBy', 'updatedAt', 'updatedBy']); // ADR-63 TRANSITIONAL (STAGE 1): variationLineCount is OPTIONAL at create while the M3-B1 bundle is served",
  },
  // ADR-65 (Constrapp GANTT™ 1A2): the FINAL file requires `revision` + 1 on
  // every activity update; the 1A1 bundle writes an unchanged revision, so
  // Stage 1 accepts EITHER (the optional `predecessors` key needs no marker —
  // it is admitted by hasOnly in both files). Everything else in the block
  // (roles, shape, stamps, cancellation) is identical and ACTIVE from Stage 1.
  {
    name: 'activities update — the revision contract',
    final:
      "                  && revisionIncremented() // ADR-65 FINAL: revision +1 is REQUIRED on every activity update",
    transitional:
      "                  && (request.resource.data.revision == resource.data.revision || revisionIncremented()) // ADR-65 TRANSITIONAL (STAGE 1): an UNCHANGED revision is still accepted while the 1A1 bundle is served",
  },
]

// Kept for callers that pin the first pair by name.
export const FINAL_LINE = LINE_PAIRS[0].final
export const TRANSITIONAL_LINE = LINE_PAIRS[0].transitional

const HEADER_FINAL = "rules_version = '2';"
export const HEADER_TRANSITIONAL_LINES = [
  '// ⚠️ ADR-63 / ADR-65 STAGE-1 TRANSITIONAL RULESET — derived from firestore.rules by',
  '// scripts/build-transitional-rules.mjs; never edit by hand. Differs from the',
  `// FINAL ruleset in exactly ${LINE_PAIRS.length} rule lines (search "TRANSITIONAL (STAGE 1)"). Deploy`,
  '// FIRST (firebase.transitional.json), before the M3-B2 / GANTT 1A2 Hosting bundle; replace',
  '// with firestore.rules (FINAL) once the new bundle is live. Temporary compatibility only.',
]
const HEADER_TRANSITIONAL = HEADER_FINAL + '\n' + HEADER_TRANSITIONAL_LINES.join('\n')

export function buildTransitionalRules(finalSource) {
  if (!finalSource.startsWith(HEADER_FINAL)) {
    throw new Error('firestore.rules does not start with the rules_version header')
  }
  let out = finalSource.slice(HEADER_FINAL.length)
  for (const pair of LINE_PAIRS) {
    const occurrences = out.split(pair.final).length - 1
    if (occurrences !== 1) {
      throw new Error(`Expected exactly one FINAL marker line for "${pair.name}" in firestore.rules, found ${occurrences}`)
    }
    out = out.replace(pair.final, pair.transitional)
  }
  return HEADER_TRANSITIONAL + out
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const built = buildTransitionalRules(readFileSync(FINAL_RULES_PATH, 'utf8'))
  if (process.argv.includes('--check')) {
    const current = existsSync(TRANSITIONAL_RULES_PATH) ? readFileSync(TRANSITIONAL_RULES_PATH, 'utf8') : null
    if (current !== built) {
      console.error('firestore.transitional.rules is out of date — run: node scripts/build-transitional-rules.mjs')
      process.exit(1)
    }
    console.log('firestore.transitional.rules is up to date')
  } else {
    writeFileSync(TRANSITIONAL_RULES_PATH, built)
    console.log(`wrote ${TRANSITIONAL_RULES_PATH} (${Buffer.byteLength(built, 'utf8')} bytes)`)
  }
}
