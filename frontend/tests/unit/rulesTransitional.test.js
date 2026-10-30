import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  buildTransitionalRules, FINAL_LINE, TRANSITIONAL_LINE, FINAL_RULES_PATH, TRANSITIONAL_RULES_PATH,
} from '../../scripts/build-transitional-rules.mjs'
import { FIRESTORE_RULES_BUDGET_BYTES, FIRESTORE_RULES_HARD_LIMIT_BYTES } from './rulesSize.test.js'

// ── ADR-62 — the STAGE-1 transitional ruleset is DERIVED and cannot drift ───
//
// `firestore.rules` is FINAL (the commitment pair REQUIRED on every PO-linked
// supplier approve). `firestore.transitional.rules` is what is published FIRST,
// while the pre-M3-B1 bundle is still served: identical except that the pair is
// OPTIONAL on that one branch (the PO must still be sent/closed, a present pair
// must still be the caller's at server time). This file pins the relationship
// so a reviewer can trust the one-line diff, and the emulator suite
// `tests/rules/variationsTransitional.rules.test.js` proves the behaviour.

const finalSrc = readFileSync(FINAL_RULES_PATH, 'utf8')
const transitionalSrc = readFileSync(TRANSITIONAL_RULES_PATH, 'utf8')
const bytes = (s) => Buffer.byteLength(s, 'utf8')

describe('firestore.transitional.rules is exactly what the generator produces from firestore.rules', () => {
  it('the committed transitional file equals the generated one (run `npm run rules:transitional` after any rules change)', () => {
    expect(transitionalSrc).toBe(buildTransitionalRules(finalSrc))
  })

  it('the FINAL file carries the strict marker line exactly once and the transitional marker never', () => {
    expect(finalSrc.split(FINAL_LINE).length - 1).toBe(1)
    expect(finalSrc).not.toContain('ADR-62 TRANSITIONAL')
    expect(FINAL_LINE).toContain('appliedStamped(request.resource.data)))')
    expect(FINAL_LINE).not.toContain('appliedAbsent')
  })

  it('the TRANSITIONAL file carries its marker line exactly once, the strict line never, and a header that names it temporary', () => {
    expect(transitionalSrc.split(TRANSITIONAL_LINE).length - 1).toBe(1)
    expect(transitionalSrc).not.toContain('ADR-62 FINAL')
    expect(TRANSITIONAL_LINE).toContain('appliedAbsent(request.resource.data) || appliedStamped(request.resource.data)')
    expect(transitionalSrc.startsWith("rules_version = '2';\n// ⚠️ ADR-62 STAGE-1 TRANSITIONAL RULESET")).toBe(true)
    expect(transitionalSrc).toContain('Temporary compatibility only')
  })

  it('the two files differ in exactly one rule line (plus the five header comment lines)', () => {
    const f = finalSrc.split('\n')
    const t = transitionalSrc.split('\n')
    expect(t.length).toBe(f.length + 5)
    const tBody = [t[0], ...t.slice(6)]
    const diffs = f.map((line, i) => [line, tBody[i]]).filter(([a, b]) => a !== b)
    expect(diffs).toEqual([[FINAL_LINE, TRANSITIONAL_LINE]])
  })

  it('the PO must be sent/closed in BOTH files — the transitional file relaxes the stamps only, never the PO state', () => {
    for (const src of [finalSrc, transitionalSrc]) {
      const block = src.slice(src.indexOf('match /companies/{companyId}/projects/{projectId}/variations/{variationId}'))
      const branch = block.slice(block.indexOf('(c) APPROVE'), block.indexOf('(d) REJECT'))
      expect(branch).toContain('&& poCommitted()')
      expect(branch).toContain("resource.data.poId == null\n                          ? appliedAbsent(request.resource.data)")
    }
  })

  it('both rulesets are under the approved budget and the hard limit', () => {
    for (const src of [finalSrc, transitionalSrc]) {
      expect(bytes(src)).toBeLessThan(FIRESTORE_RULES_BUDGET_BYTES)
      expect(bytes(src)).toBeLessThan(FIRESTORE_RULES_HARD_LIMIT_BYTES)
    }
  })

  it('the generator refuses a source without exactly one marker', () => {
    expect(() => buildTransitionalRules(finalSrc.replace(FINAL_LINE, ''))).toThrow(/exactly one FINAL marker/)
    expect(() => buildTransitionalRules(finalSrc + '\n' + FINAL_LINE)).toThrow(/exactly one FINAL marker/)
  })
})
