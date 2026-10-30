import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  buildTransitionalRules, LINE_PAIRS, FINAL_LINE, TRANSITIONAL_LINE, HEADER_TRANSITIONAL_LINES, FINAL_RULES_PATH, TRANSITIONAL_RULES_PATH,
} from '../../scripts/build-transitional-rules.mjs'
import { FIRESTORE_RULES_BUDGET_BYTES, FIRESTORE_RULES_HARD_LIMIT_BYTES } from './rulesSize.test.js'

// ── ADR-62 / ADR-63 — the STAGE-1 transitional ruleset is DERIVED and cannot drift ─
//
// `firestore.rules` is FINAL: on a PO-linked supplier approve BOTH stamp pairs
// (ADR-62 applied, ADR-63 scope) are REQUIRED, and a claim create REQUIRES the
// `variationLineCount` header. `firestore.transitional.rules` is what is
// deployed FIRST, while the M3-B1 bundle is still served: identical except
// that the scope pair is OPTIONAL on that one approve branch (the applied pair
// is still required, a present scope pair must still be the caller's at
// server time, the PO must still be sent/closed) and `variationLineCount` is
// OPTIONAL at claim create (absent reads 0 everywhere else). This file pins
// the relationship so a reviewer can trust the short diff, and the emulator
// suite `tests/rules/variationsTransitional.rules.test.js` proves the behaviour.

const finalSrc = readFileSync(FINAL_RULES_PATH, 'utf8')
const transitionalSrc = readFileSync(TRANSITIONAL_RULES_PATH, 'utf8')
const bytes = (s) => Buffer.byteLength(s, 'utf8')

describe('firestore.transitional.rules is exactly what the generator produces from firestore.rules', () => {
  it('the committed transitional file equals the generated one (run `npm run rules:transitional` after any rules change)', () => {
    expect(transitionalSrc).toBe(buildTransitionalRules(finalSrc))
  })

  it('exactly two marked line pairs, and the first is still exported as FINAL_LINE / TRANSITIONAL_LINE', () => {
    expect(LINE_PAIRS).toHaveLength(2)
    expect(FINAL_LINE).toBe(LINE_PAIRS[0].final)
    expect(TRANSITIONAL_LINE).toBe(LINE_PAIRS[0].transitional)
  })

  it('the FINAL file carries each strict marker line exactly once and the transitional marker never', () => {
    for (const pair of LINE_PAIRS) {
      expect(finalSrc.split(pair.final).length - 1, pair.name).toBe(1)
      expect(finalSrc).not.toContain(pair.transitional)
    }
    expect(finalSrc).not.toContain('ADR-63 TRANSITIONAL')
    expect(finalSrc).not.toContain('ADR-62 TRANSITIONAL')
    expect(LINE_PAIRS[0].final).toContain('appliedStamped(request.resource.data) && scopeStamped(request.resource.data)))')
    expect(LINE_PAIRS[0].final).not.toContain('scopeAbsent')
    expect(LINE_PAIRS[1].final).toContain("'variationId', 'variationLineCount', 'lineItems'")
  })

  it('the TRANSITIONAL file carries each marker line exactly once, the strict lines never, and a header that names it temporary', () => {
    for (const pair of LINE_PAIRS) {
      expect(transitionalSrc.split(pair.transitional).length - 1, pair.name).toBe(1)
      expect(transitionalSrc).not.toContain(pair.final)
    }
    expect(transitionalSrc).not.toContain('ADR-63 FINAL')
    // The applied pair stays REQUIRED in Stage 1 — only the scope pair relaxes.
    expect(LINE_PAIRS[0].transitional).toContain('appliedStamped(request.resource.data) && (scopeAbsent(request.resource.data) || scopeStamped(request.resource.data))')
    expect(LINE_PAIRS[0].transitional).not.toContain('appliedAbsent')
    // Stage 1 leaves variationLineCount out of hasAll only — hasOnly still admits it.
    expect(LINE_PAIRS[1].transitional).not.toContain("'variationLineCount'")
    expect(transitionalSrc).toContain("hasOnly(['claimNumber', 'status', 'poId', 'poNumber', 'supplierName', 'supplierId', 'claimRef', 'periodEnding', 'variationId', 'variationLineCount'")
    expect(transitionalSrc.startsWith("rules_version = '2';\n// ⚠️ ADR-63 STAGE-1 TRANSITIONAL RULESET")).toBe(true)
    expect(transitionalSrc).toContain('Temporary compatibility only')
    expect(transitionalSrc).toContain('firebase.transitional.json')
  })

  it('the two files differ in exactly the marked rule lines (plus the header comment lines)', () => {
    const f = finalSrc.split('\n')
    const t = transitionalSrc.split('\n')
    expect(t.length).toBe(f.length + HEADER_TRANSITIONAL_LINES.length)
    const tBody = [t[0], ...t.slice(1 + HEADER_TRANSITIONAL_LINES.length)]
    const diffs = f.map((line, i) => [line, tBody[i]]).filter(([a, b]) => a !== b)
    const byFinal = (a, b) => a[0].localeCompare(b[0])
    expect(diffs.sort(byFinal)).toEqual(LINE_PAIRS.map(p => [p.final, p.transitional]).sort(byFinal))
  })

  it('the PO must be sent/closed in BOTH files — the transitional file relaxes the scope pair only, never the PO state or the applied pair', () => {
    for (const src of [finalSrc, transitionalSrc]) {
      const block = src.slice(src.indexOf('match /companies/{companyId}/projects/{projectId}/variations/{variationId}'))
      const branch = block.slice(block.indexOf('(c) APPROVE'), block.indexOf('(d) REJECT'))
      expect(branch).toContain('&& poCommitted()')
      expect(branch).toContain('&& appliedStamped(request.resource.data)')
      expect(branch).toContain("resource.data.poId == null\n                          ? (appliedAbsent(request.resource.data) && scopeAbsent(request.resource.data))")
    }
  })

  it('the claim line-count pin, the variation-line shape pins and the invoice count guard are identical in both files', () => {
    for (const needle of [
      'po.lineItems.size() + n == d.lineItems.size()',
      'variationLinesShaped(d.lineItems, n)',
      '&& variationLinesPreserved()',
      "let cc = claim.get('variationLineCount', 0);",
    ]) {
      expect(finalSrc).toContain(needle)
      expect(transitionalSrc).toContain(needle)
    }
  })

  it('both rulesets are under the approved budget and the hard limit', () => {
    for (const src of [finalSrc, transitionalSrc]) {
      expect(bytes(src)).toBeLessThan(FIRESTORE_RULES_BUDGET_BYTES)
      expect(bytes(src)).toBeLessThan(FIRESTORE_RULES_HARD_LIMIT_BYTES)
    }
  })

  it('the generator refuses a source without exactly one marker per pair', () => {
    expect(() => buildTransitionalRules(finalSrc.replace(LINE_PAIRS[0].final, ''))).toThrow(/exactly one FINAL marker line for "variations approve/)
    expect(() => buildTransitionalRules(finalSrc + '\n' + LINE_PAIRS[1].final)).toThrow(/exactly one FINAL marker line for "progressClaims exactKeys/)
  })
})
