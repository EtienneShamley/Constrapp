#!/usr/bin/env node
// ── ADR-62 (M3-B1) — the STAGE-1 transitional ruleset, derived, never hand-edited ──
//
// `firestore.rules` is the FINAL strict ruleset: a PO-linked supplier
// variation approves only with the commitment stamps (approve + apply in one
// write). The pre-M3-B1 production bundle approves WITHOUT the stamps, so the
// ruleset published FIRST (Stage 1, while that bundle is still served) must
// accept both the old plain approve and the new stamped approve — while still
// refusing a missing / cancelled / draft PO and every other M2 / M3 control.
//
// This script derives `firestore.transitional.rules` from `firestore.rules`
// by replacing EXACTLY ONE marked line, so the two files are reviewable as a
// one-line diff and the transitional file can never drift from the final one.
// `tests/unit/rulesTransitional.test.js` fails the suite when the committed
// transitional file differs from what this script produces, and the emulator
// suite `tests/rules/variationsTransitional.rules.test.js` proves its
// behaviour against both client payloads.
//
//   node scripts/build-transitional-rules.mjs          # write the file
//   node scripts/build-transitional-rules.mjs --check  # exit 1 if it differs
//
// Publishing is manual (DEPLOYMENT.md → Publishing Firestore Rules): the
// console takes the PASTED text of whichever file a release stage names;
// firebase.json keeps pointing at `firestore.rules` for the emulators.

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
export const FINAL_RULES_PATH = resolve(HERE, '../firestore.rules')
export const TRANSITIONAL_RULES_PATH = resolve(HERE, '../firestore.transitional.rules')

// The FINAL line (stamps required) and its STAGE-1 replacement (stamps
// optional; a stamped pair must still be the caller's at server time; the PO
// must still be sent/closed either way). Both carry an end-of-line marker so a
// reviewer can grep the live ruleset for which stage is published.
export const FINAL_LINE =
  "                              && appliedStamped(request.resource.data))) // ADR-62 FINAL: the pair is REQUIRED on a PO-linked approve"
export const TRANSITIONAL_LINE =
  "                              && (appliedAbsent(request.resource.data) || appliedStamped(request.resource.data)))) // ADR-62 TRANSITIONAL (STAGE 1): the pair is OPTIONAL while the pre-M3-B1 bundle is served"

const HEADER_FINAL = "rules_version = '2';"
const HEADER_TRANSITIONAL =
  "rules_version = '2';\n" +
  "// ⚠️ ADR-62 STAGE-1 TRANSITIONAL RULESET — derived from firestore.rules by\n" +
  "// scripts/build-transitional-rules.mjs; never edit by hand. Differs from the\n" +
  "// FINAL ruleset in exactly one line (search \"ADR-62 TRANSITIONAL\"). Publish\n" +
  "// FIRST, before the M3-B1 Hosting bundle; replace with firestore.rules (FINAL)\n" +
  "// once the new bundle is live. Temporary compatibility only."

export function buildTransitionalRules(finalSource) {
  const occurrences = finalSource.split(FINAL_LINE).length - 1
  if (occurrences !== 1) {
    throw new Error(`Expected exactly one FINAL marker line in firestore.rules, found ${occurrences}`)
  }
  if (!finalSource.startsWith(HEADER_FINAL)) {
    throw new Error('firestore.rules does not start with the rules_version header')
  }
  return HEADER_TRANSITIONAL + finalSource.slice(HEADER_FINAL.length).replace(FINAL_LINE, TRANSITIONAL_LINE)
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
