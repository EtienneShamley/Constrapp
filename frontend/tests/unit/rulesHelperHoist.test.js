import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  HOISTED_HELPERS, HELPER_BLOCK_START, helperConjuncts, expandHoist, compareHoist,
} from '../../scripts/verify-rules-helper-hoist.mjs'

// ── ADR-85 — the lifecycle-helper hoist and its prover ───────────────────────
//
// The third rules capacity recovery replaced byte-identical conjunct runs with
// calls to seven shared helpers. `scripts/verify-rules-helper-hoist.mjs` proves
// the hoisted file expands back to the pre-hoist text (run against a base
// commit by a reviewer). These tests keep that proof honest:
//
//   · the prover accepts a genuine hoist and REFUSES every way a hoist could
//     change what is evaluated (a dropped, added, altered or reordered conjunct;
//     a helper used in a position it cannot expand);
//   · the live ruleset still has the shape the prover can expand, so a later
//     edit cannot quietly make the helpers unverifiable.
//
// They do NOT prove behaviour — `npm run test:rules` does that.

const read = (name) => readFileSync(fileURLToPath(new URL(`../../${name}`, import.meta.url)), 'utf8')

const R = 'request.resource.data.'

const BODIES = {
  createStamped: [`${R}createdBy == request.auth.uid`, `${R}createdAt == request.time`],
  currencyShaped: [`${R}currency is string`, `${R}currency.matches('^[A-Z]{3}$')`],
  docCoreFrozen: [
    `${R}currency == resource.data.currency`, `${R}createdAt == resource.data.createdAt`,
    `${R}createdBy == resource.data.createdBy`, `${R}docType == resource.data.docType`,
    `${R}revision == resource.data.revision`,
  ],
  lifecycleUnstamped: [
    `${R}postedAt == null`, `${R}postedBy == null`, `${R}voidedAt == null`, `${R}voidedBy == null`,
  ],
  lifecycleStampsFrozen: [
    `${R}postedAt == resource.data.postedAt`, `${R}postedBy == resource.data.postedBy`,
    `${R}voidedAt == resource.data.voidedAt`, `${R}voidedBy == resource.data.voidedBy`,
  ],
  postedHere: [
    `${R}status == 'posted'`,
    "changedKeys().hasOnly(['status', 'postedAt', 'postedBy', 'updatedAt', 'updatedBy'])",
    `${R}postedBy == request.auth.uid`, `${R}postedAt == request.time`,
  ],
  voidedWithReason: [
    `${R}status == 'void'`,
    "changedKeys().hasOnly(['status', 'voidedAt', 'voidedBy', 'voidReason', 'updatedAt', 'updatedBy'])",
    `${R}voidedBy == request.auth.uid`, `${R}voidedAt == request.time`,
    `${R}voidReason is string`, `${R}voidReason.trim().size() > 0`,
  ],
}

const MEMBER = [
  'request.auth != null',
  'exists(/databases/$(database)/documents/users/$(request.auth.uid))',
  'get(/databases/$(database)/documents/users/$(request.auth.uid)).data.companyId == companyId',
  "get(/databases/$(database)/documents/users/$(request.auth.uid)).data.role in ['company_admin', 'project_manager', 'qs']",
]

const fn = (name, args, body) =>
  [`    function ${name}(${args}) {`, ...body.map((c, i) =>
    `      ${i === 0 ? 'return ' : '    && '}${c}${i === body.length - 1 ? ';' : ''}`), '    }']

const chain = (first, body, last = '') =>
  body.map((c, i) => `          ${i === 0 ? first : '&& '}${c}${i === body.length - 1 ? last : ''}`)

// A miniature ruleset before and after the hoist.
function original() {
  return [
    ...fn('financialMember', 'companyId', MEMBER),
    '    // A block.',
    '    match /companies/{companyId}/projects/{projectId}/things/{id} {',
    '      allow create: if financialMember(companyId)',
    ...chain('&& ', BODIES.currencyShaped),
    ...chain('&& ', BODIES.createStamped),
    ...chain('&& ', BODIES.lifecycleUnstamped, ';'),
    '      allow update: if financialMember(companyId)',
    ...chain('&& ', BODIES.docCoreFrozen),
    '          && (',
    "            (resource.data.status == 'draft'",
    ...chain('&& ', BODIES.lifecycleStampsFrozen),
    '            ) || (',
    "            resource.data.status == 'draft'",
    ...chain('&& ', BODIES.postedHere),
    '            ) || (',
    "            resource.data.status == 'posted'",
    ...chain('&& ', BODIES.voidedWithReason),
    '          ));',
    '    }',
    '    match /companies/{companyId}/projects/{projectId}/counters/{counterId} {',
    ...chain('allow read, create, update: if ', MEMBER, ';'),
    '    }',
  ].join('\n')
}

function hoisted({ bodies = BODIES, extra = [] } = {}) {
  return [
    ...fn('financialMember', 'companyId', MEMBER),
    `    ${HELPER_BLOCK_START} — test fixture.`,
    ...HOISTED_HELPERS.flatMap(name => fn(name, '', bodies[name])),
    '    // A block.',
    '    match /companies/{companyId}/projects/{projectId}/things/{id} {',
    '      allow create: if financialMember(companyId)',
    '          && currencyShaped()',
    '          && createStamped()',
    '          && lifecycleUnstamped();',
    '      allow update: if financialMember(companyId)',
    '          && docCoreFrozen()',
    '          && (',
    "            (resource.data.status == 'draft'",
    '              && lifecycleStampsFrozen()',
    '            ) || (',
    "            resource.data.status == 'draft'",
    '              && postedHere()',
    '            ) || (',
    "            resource.data.status == 'posted'",
    '              && voidedWithReason()',
    ...extra,
    '          ));',
    '    }',
    '    match /companies/{companyId}/projects/{projectId}/counters/{counterId} {',
    '      allow read, create, update: if financialMember(companyId);',
    '    }',
  ].join('\n')
}

describe('helper-hoist prover — accepts a genuine hoist', () => {
  it('expands every call site back to the original text', () => {
    const result = compareHoist(original(), hoisted())
    expect(result).toMatchObject({ ok: true, calls: 8 })
  })

  it('ignores whitespace runs only', () => {
    const reindented = hoisted().split('\n').map(l => l.replace(/^ {4}/, '  ')).join('\n')
    expect(compareHoist(original(), reindented).ok).toBe(true)
  })
})

describe('helper-hoist prover — refuses anything that changes what is evaluated', () => {
  const withBody = (name, body) => hoisted({ bodies: { ...BODIES, [name]: body } })

  it('a helper missing a conjunct', () => {
    const result = compareHoist(original(), withBody('voidedWithReason', BODIES.voidedWithReason.slice(0, -1)))
    expect(result.ok).toBe(false)
  })

  it('a helper with an added conjunct', () => {
    const result = compareHoist(original(), withBody('createStamped', [...BODIES.createStamped, 'true']))
    expect(result.ok).toBe(false)
  })

  it('a helper whose conjuncts are reordered', () => {
    const result = compareHoist(original(), withBody('postedHere', [...BODIES.postedHere].reverse()))
    expect(result).toMatchObject({ ok: false, reason: 'content differs after expansion' })
  })

  it('a helper with a weakened conjunct', () => {
    const weakened = BODIES.voidedWithReason.map(c => c.replace('.trim().size() > 0', '.size() >= 0'))
    expect(compareHoist(original(), withBody('voidedWithReason', weakened)).ok).toBe(false)
  })

  it('a call site added where the original had no such conjuncts', () => {
    const result = compareHoist(original(), hoisted({ extra: ['              && createStamped()'] }))
    expect(result.ok).toBe(false)
  })

  it('a call site removed', () => {
    const removed = hoisted().replace('          && currencyShaped()\n', '')
    expect(compareHoist(original(), removed).ok).toBe(false)
  })

  it('a helper used inside a larger expression, which cannot be expanded', () => {
    const inline = hoisted().replace('&& lifecycleUnstamped();', '&& (lifecycleUnstamped() || true);')
    const result = compareHoist(original(), inline)
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/unexpandable use of lifecycleUnstamped/)
  })

  it('a helper that is not a pure && chain', () => {
    const src = hoisted().replace(`&& ${R}createdAt == request.time;`, `|| ${R}createdAt == request.time;`)
    const result = compareHoist(original(), src)
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/pure && chain/)
  })

  it('any other executable change outside the helpers', () => {
    const changed = hoisted().replace("resource.data.status == 'posted'", "resource.data.status == 'draft'")
    expect(compareHoist(original(), changed).ok).toBe(false)
  })

  it('a changed financialMember body, through the counters substitution', () => {
    const changed = hoisted().replace("['company_admin', 'project_manager', 'qs']", "['company_admin']")
    expect(compareHoist(original(), changed).ok).toBe(false)
  })
})

describe('the live rulesets keep the shape the prover can expand', () => {
  for (const file of ['firestore.rules', 'firestore.transitional.rules', 'firestore.m2a2-transitional.rules']) {
    const source = read(file)
    const lines = source.split('\n')

    it(`${file}: each hoisted helper is declared once, with the proven body`, () => {
      for (const name of HOISTED_HELPERS) {
        const declarations = lines.filter(l => l.trim().startsWith(`function ${name}(`))
        expect(declarations, name).toHaveLength(1)
        expect(helperConjuncts(lines, name).conjuncts, name).toEqual(BODIES[name])
      }
    })

    it(`${file}: every use of a hoisted helper is a whole \`&& helper()\` line`, () => {
      const expanded = expandHoist(source)
      // 54 call sites at the hoist, plus the counters substitution; later blocks
      // written against the helpers only add to it.
      expect(expanded.calls).toBeGreaterThanOrEqual(55)
    })

    it(`${file}: the per-project counters block calls financialMember(companyId)`, () => {
      const start = source.indexOf('match /companies/{companyId}/projects/{projectId}/counters/{counterId} {')
      expect(start).toBeGreaterThan(-1)
      const block = source.slice(start, source.indexOf('allow delete: if false;', start))
      expect(block).toContain('allow read, create, update: if financialMember(companyId);')
      expect(helperConjuncts(lines, 'financialMember').conjuncts).toEqual(MEMBER)
    })
  }
})
