#!/usr/bin/env node
// ── ADR-93 / ADR-94 — the SERVER copy of the supplier-finance domain ────────
//
// `functions/src/generated/supplierFinanceCalc.js` is GENERATED from
// `src/lib/supplierFinanceCalc.js` (re-exports) and every module it reaches —
// lib/claimProcessing.js, lib/supplierInvoiceProcessing.js,
// lib/supplierSettlementProcessing.js, lib/supplierLedger.js and their
// imports. Never edited by hand. The supplier-finance callables import it, so
// every figure they store comes from the SAME source the browser previews with.
// Built exactly as the Final Account bundle is (ADR-77): `buildBundle`.

// scripts/build-final-account-bundle.mjs, with rolldown — no new dependency.
//
//   npm run functions:supplier-finance-calc          regenerate the file
//   npm run functions:supplier-finance-calc:check    exit 1 if the committed file is stale
//
// `tests/unit/supplierFinanceBundle.test.js` runs the same check in the unit
// suite and proves the bundle is self-contained and equal to its source.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { buildBundle } from './build-final-account-bundle.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const FRONTEND = resolve(HERE, '..')
export const SUPPLIER_FINANCE_ENTRY = resolve(FRONTEND, 'src/lib/supplierFinanceCalc.js')
export const SUPPLIER_FINANCE_BUNDLE_PATH = resolve(FRONTEND, 'functions/src/generated/supplierFinanceCalc.js')

export const SUPPLIER_FINANCE_BUNDLE_HEADER = [
  '// GENERATED FILE — DO NOT EDIT. Source: frontend/src/lib/supplierFinanceCalc.js and the',
  '// modules it imports. Regenerate with `npm run functions:supplier-finance-calc` (from frontend/).',
  '// ADR-93 / ADR-94: the trusted supplier-finance callables run this exact domain logic.',
  '/* eslint-disable */',
  '',
].join('\n')

export const buildSupplierFinanceBundle = () => buildBundle(SUPPLIER_FINANCE_ENTRY, SUPPLIER_FINANCE_BUNDLE_HEADER)

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const built = await buildSupplierFinanceBundle()
  if (process.argv.includes('--check')) {
    const current = existsSync(SUPPLIER_FINANCE_BUNDLE_PATH) ? readFileSync(SUPPLIER_FINANCE_BUNDLE_PATH, 'utf8') : null
    if (current !== built) {
      console.error('functions/src/generated/supplierFinanceCalc.js is out of date — run: npm run functions:supplier-finance-calc')
      process.exit(1)
    }
    console.log('functions/src/generated/supplierFinanceCalc.js is up to date')
  } else {
    mkdirSync(dirname(SUPPLIER_FINANCE_BUNDLE_PATH), { recursive: true })
    writeFileSync(SUPPLIER_FINANCE_BUNDLE_PATH, built)
    console.log(`wrote ${SUPPLIER_FINANCE_BUNDLE_PATH} (${Buffer.byteLength(built, 'utf8')} bytes)`)
  }
}
