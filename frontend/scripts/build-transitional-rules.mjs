#!/usr/bin/env node
// ── ADR-62 / ADR-63 / ADR-65 / ADR-68 — the STAGE-1 transitional ruleset, derived, never hand-edited ──
//
// `firestore.rules` is the FINAL strict ruleset. Each release that requires a
// key the previously served bundle does not write needs a STAGE-1 ruleset that
// accepts BOTH the old write and the new one while the old bundle is still
// served — and nothing else may differ. For M3-B2 (ADR-63):
//
//   · variations branch (c) — RETIRED BY ADR-90. The FINAL file used to require
//     the ADR-62 applied pair AND the ADR-63 scope pair on a PO-linked approve,
//     and Stage 1 made the scope pair optional. Approval is now a trusted
//     callable (functions/src/variations/); neither file has a client approve
//     branch, so the two files no longer differ anywhere in `variations`.
//   · progressClaims exactKeys: the FINAL file requires `variationLineCount`
//     at create; the M3-B1 bundle writes no such key, so Stage 1 leaves it
//     optional (absent reads 0 everywhere else in the block — unchanged).
//     SHIELD 2A (ADR-68) adds the three supplier-invoice LINK keys to the same
//     line: REQUIRED (null) at create by the FINAL file, optional in Stage 1
//     while the pre-2A bundle is served (an absent key is a LEGACY claim —
//     never invoiceable through the pairing until reconciled).
//   · progressClaims approve (c): the FINAL file requires the link keys to be
//     present and null after approval (the new bundle initialises them); the
//     pre-2A bundle writes none, so Stage 1 accepts an absent key as well.
//     ⚠️ The invoice-side PAIRING (supplierInvoices create and cancel) is
//     STRICT IN BOTH FILES — an unpaired claim-sourced invoice create is
//     refused from Stage 1 on (an old tab must refresh for that one action).
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
  // ADR-90 retired the FIRST pair this list carried ('variations approve — the
  // scope pair', ADR-63): approving a variation is a trusted-backend operation
  // and NEITHER file has a client approve branch any more, so there is no line
  // left to relax. The M3-B2 rollout it served has been complete since 31
  // October 2026.
  // ADR-93 retired the two progressClaims pairs ('exactKeys — variationLineCount'
  // and 'approve — the invoice link keys', ADR-63 / ADR-68): claim create and
  // approval are trusted-backend operations and NEITHER file has a client
  // create or approve branch any more. Their rollouts completed in November 2026.
  // ADR-65 (Constrapp GANTT™ 1A2): the FINAL file requires `revision` + 1 on
  // every activity update; the 1A1 bundle writes an unchanged revision, so
  // Stage 1 accepts EITHER (the optional `predecessors` key needs no marker —
  // it is admitted by hasOnly in both files). Everything else in the block
  // (roles, shape, stamps, cancellation) is identical and ACTIVE from Stage 1.
  {
    name: 'activities update — the revision contract',
    final:
      "          && revisionIncremented() // ADR-65 FINAL: revision +1 is REQUIRED on every activity update",
    transitional:
      "          && (request.resource.data.revision == resource.data.revision || revisionIncremented()) // ADR-65 TRANSITIONAL (STAGE 1): an UNCHANGED revision is still accepted while the 1A1 bundle is served",
  },
]

const HEADER_FINAL = "rules_version = '2';"
export const HEADER_TRANSITIONAL_LINES = [
  '// ⚠️ ADR-63 / ADR-65 / ADR-68 STAGE-1 TRANSITIONAL RULESET — derived from firestore.rules by',
  '// scripts/build-transitional-rules.mjs; never edit by hand. Differs from the',
  `// FINAL ruleset in exactly ${LINE_PAIRS.length} rule lines (search "TRANSITIONAL (STAGE 1)"). Deploy`,
  '// FIRST (firebase.transitional.json), before the M3-B2 / GANTT 1A2 / SHIELD 2A Hosting bundle; replace',
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

// ── M2-A2 (External Project Isolation) — a SEPARATE Stage-1 ruleset ──────────
//
// The four pairs above belong to releases whose FINAL rules are long live;
// publishing firestore.transitional.rules again would RELAX them. M2-A2
// therefore derives its own file, which differs from firestore.rules in the
// two directory-pairing lines ONLY — every other control, including the four
// strict lines above and the whole external read boundary, is the FINAL one.
// Stage 1 exists because the bundle being served when the rules are published
// still writes a project without its directory entry.
export const M2A2_TRANSITIONAL_RULES_PATH = resolve(HERE, '../firestore.m2a2-transitional.rules')

export const M2A2_LINE_PAIRS = [
  {
    name: 'projects create — the directory pair',
    final:
      "          && directoryPaired(); // M2-A2 FINAL: a project is CREATED with its directory entry",
    transitional:
      "          ; // M2-A2 TRANSITIONAL (STAGE 1): the directory entry is OPTIONAL at create while the pre-M2-A2 bundle is served",
  },
  {
    name: 'projects update — the directory pair',
    final:
      "                 && (!changedKeys().hasAny(['name', 'status', 'location', 'startDate', 'progress']) || directoryPaired()) // M2-A2 FINAL: a display-field change carries its directory entry",
    transitional:
      "                 // M2-A2 TRANSITIONAL (STAGE 1): a display-field change MAY omit its directory entry while the pre-M2-A2 bundle is served",
  },
]

export const M2A2_HEADER_TRANSITIONAL_LINES = [
  '// ⚠️ M2-A2 STAGE-1 TRANSITIONAL RULESET — derived from firestore.rules by',
  '// scripts/build-transitional-rules.mjs; never edit by hand. Differs from the',
  `// FINAL ruleset in exactly ${M2A2_LINE_PAIRS.length} rule lines (search "M2-A2 TRANSITIONAL (STAGE 1)"). Deploy`,
  '// FIRST (firebase.m2a2-transitional.json), before the M2-A2 Hosting bundle; replace',
  '// with firestore.rules (FINAL) once the new bundle is live and the directory is',
  '// backfilled. Temporary compatibility only.',
]

export function buildM2a2TransitionalRules(finalSource) {
  if (!finalSource.startsWith(HEADER_FINAL)) {
    throw new Error('firestore.rules does not start with the rules_version header')
  }
  let out = finalSource.slice(HEADER_FINAL.length)
  for (const pair of M2A2_LINE_PAIRS) {
    const occurrences = out.split(pair.final).length - 1
    if (occurrences !== 1) {
      throw new Error(`Expected exactly one FINAL marker line for "${pair.name}" in firestore.rules, found ${occurrences}`)
    }
    out = out.replace(pair.final, pair.transitional)
  }
  return HEADER_FINAL + '\n' + M2A2_HEADER_TRANSITIONAL_LINES.join('\n') + out
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const finalSource = readFileSync(FINAL_RULES_PATH, 'utf8')
  const outputs = [
    { path: TRANSITIONAL_RULES_PATH, name: 'firestore.transitional.rules', built: buildTransitionalRules(finalSource) },
    { path: M2A2_TRANSITIONAL_RULES_PATH, name: 'firestore.m2a2-transitional.rules', built: buildM2a2TransitionalRules(finalSource) },
  ]
  if (process.argv.includes('--check')) {
    let stale = false
    for (const o of outputs) {
      const current = existsSync(o.path) ? readFileSync(o.path, 'utf8') : null
      if (current !== o.built) {
        console.error(`${o.name} is out of date — run: node scripts/build-transitional-rules.mjs`)
        stale = true
      } else {
        console.log(`${o.name} is up to date`)
      }
    }
    if (stale) process.exit(1)
  } else {
    for (const o of outputs) {
      writeFileSync(o.path, o.built)
      console.log(`wrote ${o.path} (${Buffer.byteLength(o.built, 'utf8')} bytes)`)
    }
  }
}
