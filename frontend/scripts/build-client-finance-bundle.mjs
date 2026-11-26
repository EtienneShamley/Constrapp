#!/usr/bin/env node
// ── ADR-89 — the SERVER copy of the client-finance domain ────────────────────
//
// `functions/src/generated/clientFinanceCalc.js` is GENERATED from
// `src/lib/clientFinanceCalc.js` — a module of re-exports — and the modules it
// reaches (lib/money.js, lib/clientInvoices.js, lib/clientLedger.js,
// lib/clientCreditNotes.js, lib/clientRetention.js, lib/clientReceipts.js).
// Never edited by hand. The four trusted callables (postClientCreditNote,
// voidClientCreditNote, postClientRetentionRelease, voidClientRetentionRelease)
// import it, so the figures they re-derive, the ledger they advance and the
// invariants they require come from the SAME source the browser previews with.
//
// Built exactly as the Final Account bundle is (ADR-77): `buildBundle` in
// scripts/build-final-account-bundle.mjs, with rolldown — no new dependency.
//
//   npm run functions:finance-calc          regenerate the file
//   npm run functions:finance-calc:check    exit 1 if the committed file is stale
//
// `tests/unit/clientFinanceBundle.test.js` runs the same check in the unit
// suite and proves the bundle is self-contained and equal to its source.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { buildBundle } from './build-final-account-bundle.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const FRONTEND = resolve(HERE, '..')
export const FINANCE_ENTRY = resolve(FRONTEND, 'src/lib/clientFinanceCalc.js')
export const FINANCE_BUNDLE_PATH = resolve(FRONTEND, 'functions/src/generated/clientFinanceCalc.js')

export const FINANCE_BUNDLE_HEADER = [
  '// GENERATED FILE — DO NOT EDIT. Source: frontend/src/lib/clientFinanceCalc.js and the',
  '// modules it imports. Regenerate with `npm run functions:finance-calc` (from frontend/).',
  '// ADR-89: the trusted client-finance callables run this exact domain logic.',
  '/* eslint-disable */',
  '',
].join('\n')

export const buildFinanceBundle = () => buildBundle(FINANCE_ENTRY, FINANCE_BUNDLE_HEADER)

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const built = await buildFinanceBundle()
  if (process.argv.includes('--check')) {
    const current = existsSync(FINANCE_BUNDLE_PATH) ? readFileSync(FINANCE_BUNDLE_PATH, 'utf8') : null
    if (current !== built) {
      console.error('functions/src/generated/clientFinanceCalc.js is out of date — run: npm run functions:finance-calc')
      process.exit(1)
    }
    console.log('functions/src/generated/clientFinanceCalc.js is up to date')
  } else {
    mkdirSync(dirname(FINANCE_BUNDLE_PATH), { recursive: true })
    writeFileSync(FINANCE_BUNDLE_PATH, built)
    console.log(`wrote ${FINANCE_BUNDLE_PATH} (${Buffer.byteLength(built, 'utf8')} bytes)`)
  }
}
