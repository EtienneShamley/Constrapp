#!/usr/bin/env node
// ── ADR-90 — the SERVER copy of the variation domain ─────────────────────────
//
// `functions/src/generated/variationCalc.js` is GENERATED from
// `src/lib/variationCalc.js` — a module of re-exports — and the modules it
// reaches (lib/supplierCalc.js, lib/money.js, lib/variations.js,
// lib/variationActions.js, lib/variationProcessing.js, lib/currency.js).
// Never edited by hand. The three trusted callables (createVariation,
// approveVariation, applyVariationCommitment) import it, so the document they
// store, the figures they certify and the commitment decision they make come
// from the SAME source the browser previews with.
//
// Built exactly as the Final Account bundle is (ADR-77): `buildBundle` in
// scripts/build-final-account-bundle.mjs, with rolldown — no new dependency.
//
//   npm run functions:variation-calc          regenerate the file
//   npm run functions:variation-calc:check    exit 1 if the committed file is stale
//
// `tests/unit/variationBundle.test.js` runs the same check in the unit suite
// and proves the bundle is self-contained and equal to its source.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { buildBundle } from './build-final-account-bundle.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const FRONTEND = resolve(HERE, '..')
export const VARIATION_ENTRY = resolve(FRONTEND, 'src/lib/variationCalc.js')
export const VARIATION_BUNDLE_PATH = resolve(FRONTEND, 'functions/src/generated/variationCalc.js')

export const VARIATION_BUNDLE_HEADER = [
  '// GENERATED FILE — DO NOT EDIT. Source: frontend/src/lib/variationCalc.js and the',
  '// modules it imports. Regenerate with `npm run functions:variation-calc` (from frontend/).',
  '// ADR-90: the trusted variation callables run this exact domain logic.',
  '/* eslint-disable */',
  '',
].join('\n')

export const buildVariationBundle = () => buildBundle(VARIATION_ENTRY, VARIATION_BUNDLE_HEADER)

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const built = await buildVariationBundle()
  if (process.argv.includes('--check')) {
    const current = existsSync(VARIATION_BUNDLE_PATH) ? readFileSync(VARIATION_BUNDLE_PATH, 'utf8') : null
    if (current !== built) {
      console.error('functions/src/generated/variationCalc.js is out of date — run: npm run functions:variation-calc')
      process.exit(1)
    }
    console.log('functions/src/generated/variationCalc.js is up to date')
  } else {
    mkdirSync(dirname(VARIATION_BUNDLE_PATH), { recursive: true })
    writeFileSync(VARIATION_BUNDLE_PATH, built)
    console.log(`wrote ${VARIATION_BUNDLE_PATH} (${Buffer.byteLength(built, 'utf8')} bytes)`)
  }
}
