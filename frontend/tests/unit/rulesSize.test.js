import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// ── Firestore Security Rules — source-size budget ───────────────────────────
//
// Firestore refuses to publish a ruleset whose SOURCE TEXT exceeds 256 KB
// (262,144 bytes). When that happens in the console the previous ruleset
// simply stays active — every path added since is denied by default, and the
// app reports those collections as "unavailable" (the Quant™ 1A production
// incident, October 2026: the file had grown to 264,907 bytes).
//
// This test fails the unit suite — and therefore CI — before a publish can.
// It measures UTF-8 BYTES (the limit is a byte limit; the file contains
// multi-byte characters such as "—", "™" and "⚠️", so a character count would
// under-report). The BUDGET is deliberately below the hard limit so there is
// headroom for the next collections; raising it is an explicit decision.
//
// ⚠️ Passing here proves source-size compliance ONLY. It does not prove that
// the ruleset in production is this one — see docs/DEPLOYMENT.md → Verifying
// which rules are published.

const RULES_PATH = fileURLToPath(new URL('../../firestore.rules', import.meta.url))
const STORAGE_RULES_PATH = fileURLToPath(new URL('../../storage.rules', import.meta.url))

export const FIRESTORE_RULES_HARD_LIMIT_BYTES = 262_144 // Firestore: 256 KB of source text
export const FIRESTORE_RULES_BUDGET_BYTES = 245_000     // the approved working budget (ADR-51 hotfix)

const utf8Bytes = (path) => Buffer.byteLength(readFileSync(path, 'utf8'), 'utf8')

describe('firestore.rules source-size budget', () => {
  const bytes = utf8Bytes(RULES_PATH)

  it(`is under the approved budget of ${FIRESTORE_RULES_BUDGET_BYTES} UTF-8 bytes (currently ${bytes})`, () => {
    expect(bytes).toBeLessThan(FIRESTORE_RULES_BUDGET_BYTES)
  })

  it('is under the Firestore hard limit of 262,144 bytes (256 KB) — publishing is refused above it', () => {
    expect(bytes).toBeLessThan(FIRESTORE_RULES_HARD_LIMIT_BYTES)
  })

  it('the budget leaves real headroom below the hard limit', () => {
    expect(FIRESTORE_RULES_BUDGET_BYTES).toBeLessThan(FIRESTORE_RULES_HARD_LIMIT_BYTES)
    expect(FIRESTORE_RULES_HARD_LIMIT_BYTES - FIRESTORE_RULES_BUDGET_BYTES).toBeGreaterThanOrEqual(15_000)
  })

  it('measures bytes, not characters — the file is not pure ASCII', () => {
    const text = readFileSync(RULES_PATH, 'utf8')
    expect(bytes).toBeGreaterThan(text.length)
  })
})

describe('storage.rules source-size (same limit applies)', () => {
  it('is far below the hard limit', () => {
    expect(utf8Bytes(STORAGE_RULES_PATH)).toBeLessThan(FIRESTORE_RULES_HARD_LIMIT_BYTES / 4)
  })
})
