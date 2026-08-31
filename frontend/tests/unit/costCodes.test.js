import { describe, it, expect } from 'vitest'
import {
  costCodeDisplayName,
  isActiveCostCode,
  activeCostCodes,
  resolveCostCodeName,
  normaliseCostCode,
  isDuplicateCostCode,
  buildCostCodeFields,
  validateCostCode,
  COST_CODE_MAX_LENGTH,
  COST_CODE_NAME_MAX_LENGTH,
  COST_CODE_CATEGORY_MAX_LENGTH,
  COST_CODE_UNIT_MAX_LENGTH,
  COST_CODE_DEACTIVATE_NOTICE,
} from '../../src/lib/costCodes'

// ── Cost Codes — pure unit tests (ADR-39) ────────────────────────────────────
//
// Exercises lib/costCodes.js as plain functions. The Firestore Rules suite is
// separate (tests/rules/costCodes.rules.test.js, npm run test:rules).
//
// The load-bearing contracts proved here:
//   · a MISSING `isActive` means ACTIVE (legacy documents predate the flag),
//   · duplicate detection is case- and whitespace-insensitive and EXCLUDES the
//     record being edited, and
//   · name resolution prefers the LIVE cost code and falls back to the stored
//     snapshot — the mechanism that lets a rename appear everywhere without any
//     historical document being rewritten.

const cc = (overrides = {}) => ({
  id: 'cc1', code: '03-100', name: 'Concrete Slab',
  category: 'Structure', unit: 'm3', isActive: true,
  ...overrides,
})

describe('costCodes — costCodeDisplayName', () => {
  it('composes "code — name"', () => {
    expect(costCodeDisplayName(cc())).toBe('03-100 — Concrete Slab')
  })

  it('returns "" for a missing cost code', () => {
    expect(costCodeDisplayName(null)).toBe('')
    expect(costCodeDisplayName(undefined)).toBe('')
  })
})

describe('costCodes — active/inactive', () => {
  it('treats an explicit true as active', () => {
    expect(isActiveCostCode(cc({ isActive: true }))).toBe(true)
  })

  it('treats an explicit false as inactive', () => {
    expect(isActiveCostCode(cc({ isActive: false }))).toBe(false)
  })

  it('treats a MISSING isActive as ACTIVE — legacy documents predate the flag', () => {
    const legacy = { id: 'cc9', code: '01-000', name: 'Preliminaries' }
    expect('isActive' in legacy).toBe(false)
    expect(isActiveCostCode(legacy)).toBe(true)
    expect(activeCostCodes([legacy])).toEqual([legacy])
  })

  it('treats undefined/null isActive as active, matching every picker in the app', () => {
    expect(isActiveCostCode(cc({ isActive: undefined }))).toBe(true)
    expect(isActiveCostCode(cc({ isActive: null }))).toBe(true)
  })

  it('activeCostCodes filters only the explicitly deactivated', () => {
    const a = cc({ id: 'a' })
    const b = cc({ id: 'b', isActive: false })
    const c = { id: 'c', code: '02-000', name: 'Legacy' }
    expect(activeCostCodes([a, b, c])).toEqual([a, c])
  })

  it('activeCostCodes tolerates a missing or empty list', () => {
    expect(activeCostCodes(null)).toEqual([])
    expect(activeCostCodes(undefined)).toEqual([])
    expect(activeCostCodes([])).toEqual([])
  })
})

describe('costCodes — resolveCostCodeName', () => {
  const list = [cc({ id: 'cc1', code: '03-110', name: 'Concrete Slab — Suspended' })]

  it('prefers the LIVE cost code, so a rename shows immediately', () => {
    // The document still stores the OLD snapshot; the resolver returns the new
    // label without anything being written.
    expect(resolveCostCodeName('cc1', list, '03-100 — Concrete Slab'))
      .toBe('03-110 — Concrete Slab — Suspended')
  })

  it('resolves an INACTIVE cost code live too — deactivation is not deletion', () => {
    const inactive = [cc({ id: 'cc1', code: '03-100', name: 'Concrete Slab', isActive: false })]
    expect(resolveCostCodeName('cc1', inactive, 'stale snapshot')).toBe('03-100 — Concrete Slab')
  })

  it('falls back to the stored snapshot when the code is not in the list', () => {
    expect(resolveCostCodeName('gone', list, '03-100 — Concrete Slab'))
      .toBe('03-100 — Concrete Slab')
  })

  it('falls back to "Unknown cost code" when there is no live code and no snapshot', () => {
    for (const snapshot of ['', '   ', null, undefined]) {
      expect(resolveCostCodeName('gone', list, snapshot)).toBe('Unknown cost code')
    }
  })

  it('matches the fallback chain lib/forecast.js and lib/boq.js already use', () => {
    // Same three-step order: live → stored snapshot → placeholder.
    expect(resolveCostCodeName('cc1', list, 'snap')).toBe('03-110 — Concrete Slab — Suspended')
    expect(resolveCostCodeName('cc2', list, 'snap')).toBe('snap')
    expect(resolveCostCodeName('cc2', list, '')).toBe('Unknown cost code')
  })

  it('tolerates a missing cost-code list', () => {
    expect(resolveCostCodeName('cc1', null, 'snap')).toBe('snap')
    expect(resolveCostCodeName('cc1', undefined, null)).toBe('Unknown cost code')
  })
})

describe('costCodes — duplicate detection', () => {
  it('normalises case, surrounding and internal whitespace', () => {
    expect(normaliseCostCode('  03-100  ')).toBe('03-100')
    expect(normaliseCostCode('03-100')).toBe(normaliseCostCode('03-100'))
    expect(normaliseCostCode('AB 100')).toBe('ab 100')
    expect(normaliseCostCode('AB  100')).toBe('ab 100')
    expect(normaliseCostCode('ab\t100')).toBe('ab 100')
  })

  it('normalises null/undefined to ""', () => {
    expect(normaliseCostCode(null)).toBe('')
    expect(normaliseCostCode(undefined)).toBe('')
  })

  it('detects a case-insensitive duplicate', () => {
    const list = [cc({ id: 'cc1', code: 'AB-100' })]
    expect(isDuplicateCostCode(list, 'ab-100')).toBe(true)
    expect(isDuplicateCostCode(list, 'AB-100')).toBe(true)
  })

  it('detects a whitespace-insensitive duplicate', () => {
    const list = [cc({ id: 'cc1', code: '03 100' })]
    expect(isDuplicateCostCode(list, '  03   100 ')).toBe(true)
  })

  it('EXCLUDES the record being edited, so saving an unrelated field is not blocked', () => {
    const list = [cc({ id: 'cc1', code: '03-100' })]
    expect(isDuplicateCostCode(list, '03-100', 'cc1')).toBe(false)
    // …but a different record holding the same code is still a duplicate.
    expect(isDuplicateCostCode(list, '03-100', 'cc2')).toBe(true)
  })

  it('does not flag a genuinely new code', () => {
    const list = [cc({ id: 'cc1', code: '03-100' })]
    expect(isDuplicateCostCode(list, '03-200')).toBe(false)
  })

  it('never flags a blank candidate — that is a required-field error, not a clash', () => {
    const list = [cc({ id: 'cc1', code: '' })]
    expect(isDuplicateCostCode(list, '')).toBe(false)
    expect(isDuplicateCostCode(list, '   ')).toBe(false)
  })

  it('tolerates a missing list', () => {
    expect(isDuplicateCostCode(null, '03-100')).toBe(false)
    expect(isDuplicateCostCode(undefined, '03-100')).toBe(false)
  })
})

describe('costCodes — buildCostCodeFields', () => {
  it('trims every field', () => {
    expect(buildCostCodeFields({
      code: '  03-100 ', name: '  Concrete Slab ', category: ' Structure ', unit: '  m3 ',
    })).toEqual({ code: '03-100', name: 'Concrete Slab', category: 'Structure', unit: 'm3' })
  })

  it('coerces missing optional fields to empty strings, matching the create path', () => {
    expect(buildCostCodeFields({ code: '03-100', name: 'Concrete' }))
      .toEqual({ code: '03-100', name: 'Concrete', category: '', unit: '' })
  })

  it('never emits isActive — availability belongs to Deactivate/Reactivate alone', () => {
    const built = buildCostCodeFields({ code: 'a', name: 'b', isActive: false })
    expect('isActive' in built).toBe(false)
    expect(Object.keys(built).sort()).toEqual(['category', 'code', 'name', 'unit'])
  })

  it('never emits provenance keys', () => {
    const built = buildCostCodeFields({
      code: 'a', name: 'b', createdAt: 'x', createdBy: 'y', id: 'z',
    })
    for (const forbidden of ['createdAt', 'createdBy', 'id']) {
      expect(forbidden in built).toBe(false)
    }
  })
})

describe('costCodes — validateCostCode', () => {
  const ok = { code: '03-100', name: 'Concrete Slab', category: 'Structure', unit: 'm3' }

  it('accepts a well-formed cost code', () => {
    expect(validateCostCode(ok)).toBeNull()
  })

  it('requires a non-blank code and name', () => {
    expect(validateCostCode({ ...ok, code: '   ' })).toMatch(/code is required/i)
    expect(validateCostCode({ ...ok, name: '' })).toMatch(/name is required/i)
  })

  it('bounds every field', () => {
    expect(validateCostCode({ ...ok, code: 'x'.repeat(COST_CODE_MAX_LENGTH) })).toBeNull()
    expect(validateCostCode({ ...ok, code: 'x'.repeat(COST_CODE_MAX_LENGTH + 1) })).toMatch(/fewer/i)
    expect(validateCostCode({ ...ok, name: 'x'.repeat(COST_CODE_NAME_MAX_LENGTH + 1) })).toMatch(/fewer/i)
    expect(validateCostCode({ ...ok, category: 'x'.repeat(COST_CODE_CATEGORY_MAX_LENGTH + 1) })).toMatch(/fewer/i)
    expect(validateCostCode({ ...ok, unit: 'x'.repeat(COST_CODE_UNIT_MAX_LENGTH + 1) })).toMatch(/fewer/i)
  })

  it('allows a blank category and unit', () => {
    expect(validateCostCode({ ...ok, category: '', unit: '' })).toBeNull()
  })

  it('blocks a duplicate code when the live list is supplied', () => {
    const list = [cc({ id: 'cc1', code: '03-100' })]
    expect(validateCostCode(ok, { costCodes: list })).toMatch(/already in use/i)
  })

  it('does NOT block the record being edited against itself', () => {
    const list = [cc({ id: 'cc1', code: '03-100' })]
    expect(validateCostCode(ok, { costCodes: list, excludeId: 'cc1' })).toBeNull()
  })

  it('skips the duplicate check entirely when no list is supplied', () => {
    expect(validateCostCode(ok, {})).toBeNull()
    expect(validateCostCode(ok, { costCodes: null })).toBeNull()
  })
})

describe('costCodes — deactivation notice', () => {
  it('promises no figure changes and makes NO claim about how many records use the code', () => {
    // Cost codes are company-wide while budget lines and orders are per-project,
    // so any count this page could compute would cover one project and read as
    // though it covered the company.
    expect(COST_CODE_DEACTIVATE_NOTICE).toMatch(/reactivate/i)
    expect(COST_CODE_DEACTIVATE_NOTICE).toMatch(/no\s+Budgeted/i)
    expect(COST_CODE_DEACTIVATE_NOTICE).not.toMatch(/\d+\s+(budget line|record)/i)
  })
})
