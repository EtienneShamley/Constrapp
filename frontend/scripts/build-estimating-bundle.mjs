#!/usr/bin/env node
// ── ADR-97 — the SERVER copy of the estimating domain ────────────────────────
//
// `functions/src/generated/estimatingCalc.js` is GENERATED from
// `src/lib/estimatingCalc.js` (a re-export of lib/estimating.js) and every
// module it reaches. Never edited by hand. The `estimateOperation` callable
// imports it, so every figure it stores comes from the SAME source the browser
// previews with.
// Built exactly as the Final Account bundle is (ADR-77): `buildBundle`.

// scripts/build-final-account-bundle.mjs, with rolldown — no new dependency.
//
//   npm run functions:estimating-calc          regenerate the file
//   npm run functions:estimating-calc:check    exit 1 if the committed file is stale
//
// `tests/unit/estimatingBundle.test.js` runs the same check in the unit
// suite and proves the bundle is self-contained and equal to its source.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { buildBundle } from './build-final-account-bundle.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const FRONTEND = resolve(HERE, '..')
export const ESTIMATING_ENTRY = resolve(FRONTEND, 'src/lib/estimatingCalc.js')
export const ESTIMATING_BUNDLE_PATH = resolve(FRONTEND, 'functions/src/generated/estimatingCalc.js')

export const ESTIMATING_BUNDLE_HEADER = [
  '// GENERATED FILE — DO NOT EDIT. Source: frontend/src/lib/estimatingCalc.js and the',
  '// modules it imports. Regenerate with `npm run functions:estimating-calc` (from frontend/).',
  '// ADR-97: the trusted estimateOperation callable runs this exact domain logic.',
  '/* eslint-disable */',
  '',
].join('\n')

export const buildEstimatingBundle = () => buildBundle(ESTIMATING_ENTRY, ESTIMATING_BUNDLE_HEADER)

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const built = await buildEstimatingBundle()
  if (process.argv.includes('--check')) {
    const current = existsSync(ESTIMATING_BUNDLE_PATH) ? readFileSync(ESTIMATING_BUNDLE_PATH, 'utf8') : null
    if (current !== built) {
      console.error('functions/src/generated/estimatingCalc.js is out of date — run: npm run functions:estimating-calc')
      process.exit(1)
    }
    console.log('functions/src/generated/estimatingCalc.js is up to date')
  } else {
    mkdirSync(dirname(ESTIMATING_BUNDLE_PATH), { recursive: true })
    writeFileSync(ESTIMATING_BUNDLE_PATH, built)
    console.log(`wrote ${ESTIMATING_BUNDLE_PATH} (${Buffer.byteLength(built, 'utf8')} bytes)`)
  }
}
