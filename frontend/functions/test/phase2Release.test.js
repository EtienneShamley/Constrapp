import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// ── Phase 2 release safety (ADR-98) — pins that do not need the emulators ────
//
// The switches the cutover turns on at stage F must DEFAULT TO OFF in code and
// be OFF in the production env file; the leases that protect a building
// baseline / estimate revision must outlast the callable that holds them (a
// live run is never taken over); and no Phase 2 log line may carry a money total.

const DIR = fileURLToPath(new URL('..', import.meta.url))
const src = (rel) => readFileSync(fileURLToPath(new URL(`../src/${rel}`, import.meta.url)), 'utf8')
const envFiles = readdirSync(DIR).filter(f => /^\.env\.[a-z0-9-]+$/.test(f) && f !== '.env.local')
const valueOf = (file, key) => (readFileSync(join(DIR, file), 'utf8').split('\n').find(l => l.startsWith(`${key}=`)) ?? '').slice(key.length + 1).trim()
const numberAfter = (text, re) => Number(String(text.match(re)?.[1] ?? 'NaN').replace(/_/g, ''))

describe('the stage F switches default OFF and are OFF in production', () => {
  for (const key of ['SUPPLIER_FINANCE_PROCESSING_ENABLED', 'CONTRACT_VALUE_REVISION_ENABLED', 'ESTIMATING_ENABLED', 'CLIENT_SETTLEMENT_ENABLED', 'VARIATION_PROCESSING_ENABLED']) {
    it(`${key}: default false in code, stated in every env file, false in .env.constrapp-69b5d, true for the emulator`, () => {
      expect(src('lib/params.js')).toContain(`export const ${key} = defineBoolean('${key}', { default: false })`)
      for (const f of envFiles) expect(['true', 'false'], `${f} ${key}`).toContain(valueOf(f, key))
      expect(valueOf('.env.constrapp-69b5d', key)).toBe('false')
      expect(valueOf('.env.demo-constrap-test', key)).toBe('true')
    })
  }
})

describe('leases outlast the callables that hold them', () => {
  const index = src('index.js')
  const timeoutOf = (name) => numberAfter(index.slice(index.indexOf(`export const ${name} = {`)), /timeoutSeconds:\s*([0-9_]+)/) * 1000
  it('the supplier-finance baseline lease (BASELINE_LEASE_MS) exceeds the supplier-finance timeout', () => {
    const lease = numberAfter(src('supplierFinance/baseline.js'), /export const BASELINE_LEASE_MS = ([0-9_]+)/)
    expect(lease).toBeGreaterThan(timeoutOf('SUPPLIER_FINANCE_CALL_OPTIONS'))
  })
  it('the estimate build lease (ESTIMATE_BUILD_LEASE_MS) exceeds the estimating timeout', () => {
    const lease = numberAfter(src('estimating/operations.js'), /export const ESTIMATE_BUILD_LEASE_MS = ([0-9_]+)/)
    expect(lease).toBeGreaterThan(timeoutOf('ESTIMATE_CALL_OPTIONS'))
  })
})

describe('logs carry no money totals', () => {
  it('the client receipt baseline log line names counts, not cents', () => {
    const text = src('clientFinance/baseline.js')
    expect(text).toContain("delete counts.legacyCents")
    expect(text).toContain("log.info('client receipt baseline established', { uid, projectId, attempts, ...counts })")
  })
})
