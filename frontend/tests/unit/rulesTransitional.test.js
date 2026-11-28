import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  buildTransitionalRules, LINE_PAIRS, HEADER_TRANSITIONAL_LINES, FINAL_RULES_PATH, TRANSITIONAL_RULES_PATH,
} from '../../scripts/build-transitional-rules.mjs'
import { FIRESTORE_RULES_BUDGET_BYTES, FIRESTORE_RULES_HARD_LIMIT_BYTES } from './rulesSize.test.js'

// ── The STAGE-1 transitional ruleset is DERIVED and cannot drift (ADR-63 · ADR-65 · ADR-68 · ADR-90) ─
//
// `firestore.rules` is FINAL. `firestore.transitional.rules` is the ruleset
// that was deployed FIRST in each staged release, while the previous bundle was
// still served: identical except for the marked lines, each of which makes ONE
// newly required key optional (a claim's `variationLineCount` and its invoice
// link keys at create; the activities revision contract; the invoice link keys
// at claim approval). This file pins the relationship so a reviewer can trust
// the short diff; the emulator suite
// `tests/rules/variationsTransitional.rules.test.js` proves the behaviour.
//
// ADR-90 RETIRED THE FIRST PAIR this list carried ('variations approve — the
// scope pair', ADR-63): approving a variation is a trusted-backend operation,
// neither file has a client approve branch, and the two files' `variations`
// blocks are now byte-identical (asserted below). Three pairs remain.

const finalSrc = readFileSync(FINAL_RULES_PATH, 'utf8')
const transitionalSrc = readFileSync(TRANSITIONAL_RULES_PATH, 'utf8')
const bytes = (s) => Buffer.byteLength(s, 'utf8')

describe('firestore.transitional.rules is exactly what the generator produces from firestore.rules', () => {
  it('the committed transitional file equals the generated one (run `npm run rules:transitional` after any rules change)', () => {
    expect(transitionalSrc).toBe(buildTransitionalRules(finalSrc))
  })

  // ADR-65 added the activities revision pair; ADR-68 (SHIELD 2A) the
  // approve-time invoice link keys. ADR-90 retired the variations pair and
  // ADR-93 the two progressClaims pairs: claim create and approve are trusted
  // backend operations, so NEITHER file has a client create or approve branch
  // left to relax. One pair remains, preserved byte for byte.
  it('exactly ONE marked line pair — ADR-90 retired the variations pair, ADR-93 the two progressClaims pairs', () => {
    expect(LINE_PAIRS).toHaveLength(1)
    expect(LINE_PAIRS.map(p => p.name)).toEqual(['activities update — the revision contract'])
    for (const pair of LINE_PAIRS) {
      expect(pair.final).not.toContain('scopeStamped')
      expect(pair.transitional).not.toContain('scopeAbsent')
    }
  })

  it('the FINAL file carries each strict marker line exactly once and the transitional marker never', () => {
    for (const pair of LINE_PAIRS) {
      expect(finalSrc.split(pair.final).length - 1, pair.name).toBe(1)
      expect(finalSrc).not.toContain(pair.transitional)
    }
    expect(finalSrc).not.toContain('TRANSITIONAL (STAGE 1)')
    expect(finalSrc).not.toContain('ADR-62 TRANSITIONAL')
    expect(finalSrc).not.toContain('ADR-63 FINAL: BOTH pairs are REQUIRED')
    // ADR-93: the retired claim markers are gone from the FINAL file too.
    expect(finalSrc).not.toContain('ADR-63 / ADR-68 FINAL')
    expect(finalSrc).not.toContain('// ADR-68 FINAL')
    expect(LINE_PAIRS[0].final).toContain('&& revisionIncremented() // ADR-65 FINAL')
    expect(LINE_PAIRS[0].final).not.toContain('resource.data.revision ||')
    expect(finalSrc).not.toContain('ADR-68 TRANSITIONAL')
  })

  it('the TRANSITIONAL file carries each marker line exactly once, the strict lines never, and a header that names it temporary', () => {
    for (const pair of LINE_PAIRS) {
      expect(transitionalSrc.split(pair.transitional).length - 1, pair.name).toBe(1)
      expect(transitionalSrc).not.toContain(pair.final)
    }
    expect(transitionalSrc).not.toContain('ADR-63 FINAL')
    expect(transitionalSrc).not.toContain('ADR-65 FINAL')
    // ADR-90 / ADR-93: Stage 1 relaxes NOTHING in `variations` or `progressClaims`.
    expect(transitionalSrc).not.toContain('ADR-63 TRANSITIONAL (STAGE 1): the scope pair is OPTIONAL')
    expect(transitionalSrc).not.toContain('ADR-63 / ADR-68 TRANSITIONAL')
    expect(transitionalSrc).not.toContain('ADR-68 TRANSITIONAL')
    expect(transitionalSrc).not.toContain('scopeAbsent(request.resource.data) || scopeStamped(request.resource.data)')
    // ADR-65: Stage 1 accepts an UNCHANGED revision OR +1 — never +2, never backwards.
    expect(LINE_PAIRS[0].transitional).toContain('(request.resource.data.revision == resource.data.revision || revisionIncremented())')
    expect(transitionalSrc.startsWith("rules_version = '2';\n// ⚠️ ADR-63 / ADR-65 / ADR-68 STAGE-1 TRANSITIONAL RULESET")).toBe(true)
    expect(transitionalSrc).toContain('Temporary compatibility only')
    expect(transitionalSrc).toContain('firebase.transitional.json')
  })

  it('the activities block is otherwise identical in both files: create at revision 1, the predecessor pins, the cancel keys', () => {
    for (const src of [finalSrc, transitionalSrc]) {
      const block = src.slice(src.indexOf('match /companies/{companyId}/projects/{projectId}/activities/{activityId}'), src.indexOf('match /companies/{companyId}/projects/{projectId}/retentionReleases/'))
      expect(block).toContain('&& request.resource.data.revision == 1\n')
      expect(block).toContain('function predecessorEntryValid(e)')
      expect(block).toContain('&& p.size() <= 20')
      expect(block).toContain('predecessorEntryValid(p[0]) && predecessorEntryValid(p[p.size() - 1])')
      expect(block).toContain("&& e.activityId != activityId")
      expect(block).toContain("&& e.type == 'FS'")
      expect(block).toContain('&& e.lagDays >= 0\n            && e.lagDays <= 365')
      expect(block).toContain("changedKeys().hasOnly(['status', 'cancelReason', 'cancelledAt', 'cancelledBy', 'revision', 'updatedAt', 'updatedBy'])")
      expect(block).not.toContain('request.resource.data.revision  == resource.data.revision') // corePreserved no longer pins it
    }
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

  // Replaces "the PO must be sent/closed in BOTH files" (the approve branch that
  // test read no longer exists): since ADR-90 the PO state, the stamp pairs and
  // the certified figures are enforced by the trusted backend
  // (tests/functions/variations.test.js), and BOTH rulesets refuse the client
  // write outright.
  it('ADR-90 — in BOTH files the variations block has no client create, no draft-edit branch, no approve branch and no legacy apply branch — only the read and the three content-free transitions — and the two blocks are byte-identical', () => {
    const variationsBlock = (src) => {
      const from = src.indexOf('match /companies/{companyId}/projects/{projectId}/variations/{variationId}')
      const to = src.indexOf('match /companies/{companyId}/projects/{projectId}/forecastLines/{costCodeId}')
      expect(from).toBeGreaterThan(-1)
      expect(to).toBeGreaterThan(from)
      return src.slice(from, to)
    }
    for (const src of [finalSrc, transitionalSrc]) {
      const block = variationsBlock(src)
      expect(block).toContain('allow create: if false;')
      expect(block).not.toContain('(c) APPROVE')
      expect(block).not.toContain('legacyCommitValid')
      expect(block).not.toContain('appliedStamped')
      expect(block).not.toContain('scopeStamped')
      expect(block).not.toContain('poCommitted')
      expect(block).not.toContain("request.resource.data.status == 'approved'")
      expect(block).not.toMatch(/commitmentApplied|scopeCommitted/)
      // What stays with the Rules is still there.
      // Checkpoint-1 correction: the draft edit is the backend's too
      // (updateVariationDraft) — no branch, and none of the helpers that
      // validated authored content, header money or the ADR-34 link.
      expect(block).not.toContain('(a) DRAFT EDIT')
      for (const gone of ['contentShapeValid', 'originRfiValid', 'originRfiDoc', 'originChanged', 'moneyValid', 'wholeCents', 'refsValid']) expect(block, gone).not.toContain(gone)
      expect(block).not.toMatch(/'lineItems',|'submittedSubtotal'|'title'/)   // no branch names a content key
      expect((block.match(/changedKeys\(\)\.hasOnly\(/g) || []).length).toBe(3)
      // What stays with the Rules is still there.
      expect(block).toContain('allow read: if variationMember();')
      expect(block).toContain('(b) SUBMIT')
      expect(block).toContain('(d) REJECT')
      expect(block).toContain('(e) WITHDRAW')
      expect(block).toContain('allow delete: if false;')
    }
    expect(variationsBlock(transitionalSrc)).toBe(variationsBlock(finalSrc))
  })

  // Replaces "the claim line-count pin … and the ADR-68 invoice pairing are
  // identical in both files": since ADR-93 / ADR-94 the line-count pins, the
  // pairing and every financial invariant of claims and supplier invoices are
  // enforced by the trusted backend (tests/functions/supplierFinance.test.js),
  // and BOTH rulesets refuse every client write to the supplier registers
  // except the content-free claim submit — byte-identically.
  it('ADR-93 / ADR-94 — in BOTH files the five supplier blocks admit no client write but the claim SUBMIT, and are byte-identical', () => {
    const block = (src, name, next) => src.slice(src.indexOf(`match /companies/{companyId}/projects/{projectId}/${name}/`), src.indexOf(next, src.indexOf(`match /companies/{companyId}/projects/{projectId}/${name}/`)))
    for (const name of ['supplierInvoices', 'supplierPayments', 'supplierCreditNotes', 'retentionReleases']) {
      for (const src of [finalSrc, transitionalSrc]) {
        const b = block(src, name, '\n    }\n')
        expect(b, name).toContain('allow create, update, delete: if false;')
        expect(b, name).not.toMatch(/allow (create|update|write)[^;]*if (?!false)/)
      }
      expect(block(finalSrc, name, '\n    }\n')).toBe(block(transitionalSrc, name, '\n    }\n'))
    }
    for (const src of [finalSrc, transitionalSrc]) {
      const b = block(src, 'progressClaims', '\n    }\n')
      expect(b).toContain('allow create: if false;')
      expect(b).toContain("changedKeys().hasOnly(['status', 'submittedAt', 'submittedBy', 'revision', 'updatedAt', 'updatedBy'])")
      expect(b).toContain("&& request.resource.data.status == 'submitted'")
      expect(b).not.toContain('linkedInvoiceCreatedHere')
    }
    expect(block(finalSrc, 'progressClaims', '\n    }\n')).toBe(block(transitionalSrc, 'progressClaims', '\n    }\n'))
  })

  it('both rulesets are under the approved budget and the hard limit', () => {
    for (const src of [finalSrc, transitionalSrc]) {
      expect(bytes(src)).toBeLessThan(FIRESTORE_RULES_BUDGET_BYTES)
      expect(bytes(src)).toBeLessThan(FIRESTORE_RULES_HARD_LIMIT_BYTES)
    }
  })

  it('the generator refuses a source without exactly one marker per pair', () => {
    expect(() => buildTransitionalRules(finalSrc.replace(LINE_PAIRS[0].final, ''))).toThrow(/exactly one FINAL marker line for "activities update/)
    expect(() => buildTransitionalRules(finalSrc + '\n' + LINE_PAIRS[0].final)).toThrow(/exactly one FINAL marker line for "activities update/)
  })
})
