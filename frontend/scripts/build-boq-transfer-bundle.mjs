#!/usr/bin/env node
// ── ADR-81 — the SERVER copy of the BOQ → budget transfer proposal ───────────
//
// `functions/src/generated/boqBudgetTransferCalc.js` is GENERATED from
// `src/lib/boqBudgetTransfer.js` and the modules it reaches (lib/boq.js,
// lib/payments.js, lib/costCodes.js, lib/currency.js) — never edited by hand.
// The trusted `transferBoqToBudget` callable imports it, so the proposal it
// recomputes, the reviewKey it compares and the amounts it writes come from
// the SAME source the browser shows the reviewer.
//
// Built exactly as the Final Account bundle is (ADR-77): `buildBundle` in
// scripts/build-final-account-bundle.mjs, with rolldown — no new dependency.
//
//   npm run functions:transfer-calc          regenerate the file
//   npm run functions:transfer-calc:check    exit 1 if the committed file is stale
//
// `tests/unit/boqBudgetTransferBundle.test.js` runs the same check in the unit
// suite and proves the bundle is self-contained and equal to its source.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { buildBundle } from './build-final-account-bundle.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const FRONTEND = resolve(HERE, '..')
export const TRANSFER_ENTRY = resolve(FRONTEND, 'src/lib/boqBudgetTransfer.js')
export const TRANSFER_BUNDLE_PATH = resolve(FRONTEND, 'functions/src/generated/boqBudgetTransferCalc.js')

export const TRANSFER_BUNDLE_HEADER = [
  '// GENERATED FILE — DO NOT EDIT. Source: frontend/src/lib/boqBudgetTransfer.js and the',
  '// modules it imports. Regenerate with `npm run functions:transfer-calc` (from frontend/).',
  '// ADR-81: the trusted transferBoqToBudget callable runs this exact proposal.',
  '/* eslint-disable */',
  '',
].join('\n')

export const buildTransferBundle = () => buildBundle(TRANSFER_ENTRY, TRANSFER_BUNDLE_HEADER)

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const built = await buildTransferBundle()
  if (process.argv.includes('--check')) {
    const current = existsSync(TRANSFER_BUNDLE_PATH) ? readFileSync(TRANSFER_BUNDLE_PATH, 'utf8') : null
    if (current !== built) {
      console.error('functions/src/generated/boqBudgetTransferCalc.js is out of date — run: npm run functions:transfer-calc')
      process.exit(1)
    }
    console.log('functions/src/generated/boqBudgetTransferCalc.js is up to date')
  } else {
    mkdirSync(dirname(TRANSFER_BUNDLE_PATH), { recursive: true })
    writeFileSync(TRANSFER_BUNDLE_PATH, built)
    console.log(`wrote ${TRANSFER_BUNDLE_PATH} (${Buffer.byteLength(built, 'utf8')} bytes)`)
  }
}
