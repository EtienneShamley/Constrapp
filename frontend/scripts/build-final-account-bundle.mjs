#!/usr/bin/env node
// ── ADR-77 — the SERVER copy of the Final Account calculation ────────────────
//
// `functions/src/generated/finalAccountCalc.js` is GENERATED from
// `src/lib/finalAccount.js` and every module it reaches (the Commercial Report
// selectors and the registers beneath them) — never edited by hand. The
// trusted `approveFinalAccount` callable imports it, so the figures it
// finalises come from the SAME source the browser runs: one formula, two
// places it executes.
//
// Why a bundle: the frontend modules use extensionless relative imports, which
// Node's ES-module loader refuses, and a Functions deploy uploads only
// `frontend/functions/`. The bundler is `rolldown`, already installed as
// Vite's bundler — no new dependency.
//
//   npm run functions:calc          regenerate the file
//   npm run functions:calc:check    exit 1 if the committed file is stale
//
// `tests/unit/finalAccountBundle.test.js` runs the same check in the unit
// suite (and so in CI and in the Functions predeploy chain via the committed
// file), proves the bundle has no import of any kind, and proves it returns
// exactly what the source module returns.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { rolldown } from 'rolldown'

const HERE = dirname(fileURLToPath(import.meta.url))
const FRONTEND = resolve(HERE, '..')
export const CALC_ENTRY = resolve(FRONTEND, 'src/lib/finalAccount.js')
export const CALC_BUNDLE_PATH = resolve(FRONTEND, 'functions/src/generated/finalAccountCalc.js')

export const CALC_BUNDLE_HEADER = [
  '// GENERATED FILE — DO NOT EDIT. Source: frontend/src/lib/finalAccount.js and the',
  '// modules it imports. Regenerate with `npm run functions:calc` (from frontend/).',
  '// ADR-77: the trusted approveFinalAccount callable runs this exact calculation.',
  '/* eslint-disable */',
  '',
].join('\n')

export async function buildCalcBundle() {
  const bundle = await rolldown({
    input: CALC_ENTRY,
    cwd: FRONTEND,
    platform: 'node',
    treeshake: true,
    logLevel: 'silent',
  })
  try {
    const { output } = await bundle.generate({ format: 'esm', minify: false, sourcemap: false })
    if (output.length !== 1) throw new Error(`expected ONE output chunk, got ${output.length}`)
    return CALC_BUNDLE_HEADER + output[0].code.replace(/\r\n/g, '\n')
  } finally {
    await bundle.close()
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const built = await buildCalcBundle()
  if (process.argv.includes('--check')) {
    const current = existsSync(CALC_BUNDLE_PATH) ? readFileSync(CALC_BUNDLE_PATH, 'utf8') : null
    if (current !== built) {
      console.error('functions/src/generated/finalAccountCalc.js is out of date — run: npm run functions:calc')
      process.exit(1)
    }
    console.log('functions/src/generated/finalAccountCalc.js is up to date')
  } else {
    mkdirSync(dirname(CALC_BUNDLE_PATH), { recursive: true })
    writeFileSync(CALC_BUNDLE_PATH, built)
    console.log(`wrote ${CALC_BUNDLE_PATH} (${Buffer.byteLength(built, 'utf8')} bytes)`)
  }
}
