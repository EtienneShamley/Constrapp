import { describe, it, expect } from 'vitest'
import {
  BUDGET_LINE_EDITABLE_KEYS,
  BUDGET_LINE_NOTES_MAX_LENGTH,
  buildBudgetLineFields,
  validateBudgetLine,
  budgetLineToForm,
} from '../../src/lib/budgetLines'

// ── Budget Lines — pure unit tests (ADR-39) ──────────────────────────────────
//
// Exercises lib/budgetLines.js as plain functions. The Firestore Rules suite is
// separate (tests/rules/budgetLines.rules.test.js, npm run test:rules), and the
// financial consequences of a `budgeted` edit are proved in
// tests/unit/foundationEditInvariance.test.js.
//
// The load-bearing contracts proved here:
//   · the editable key set is EXACTLY budgeted + notes — never `costCodeId`,
//     never `costCodeName`, never the vestigial committed/actual/invoiced,
//   · ZERO is a valid budget (a reviewed allocation of nothing), and
//   · junk does NOT silently become 0. The create path's `Number(x) || 0`
//     would turn a typo into a zero budget, which is indistinguishable from a
//     real one; on edit that must fail loudly instead of wiping an allocation.

describe('budgetLines — editable key set', () => {
  it('is exactly budgeted and notes', () => {
    expect(BUDGET_LINE_EDITABLE_KEYS).toEqual(['budgeted', 'notes'])
  })

  it('never includes the cost-code spine, the vestigial figures, or provenance', () => {
    for (const forbidden of [
      'costCodeId', 'costCodeName', 'committed', 'actual', 'invoiced', 'createdAt', 'createdBy',
    ]) {
      expect(BUDGET_LINE_EDITABLE_KEYS).not.toContain(forbidden)
    }
  })

  it('buildBudgetLineFields emits ONLY the editable keys', () => {
    const built = buildBudgetLineFields({
      budgeted: 100, notes: 'n',
      // All of the following must be dropped on the floor — re-pointing a line
      // or reviving a vestigial figure must be impossible through this helper.
      costCodeId: 'cc2', costCodeName: 'spoofed', committed: 5, actual: 5, invoiced: 5,
      createdAt: 'x', createdBy: 'y', id: 'z',
    })
    expect(Object.keys(built).sort()).toEqual(['budgeted', 'notes'])
  })
})

describe('budgetLines — buildBudgetLineFields', () => {
  it('coerces a numeric string to a number', () => {
    expect(buildBudgetLineFields({ budgeted: '12500', notes: '' }).budgeted).toBe(12500)
  })

  it('preserves decimals', () => {
    expect(buildBudgetLineFields({ budgeted: '1234.56', notes: '' }).budgeted).toBe(1234.56)
  })

  it('preserves a genuine zero', () => {
    expect(buildBudgetLineFields({ budgeted: 0, notes: '' }).budgeted).toBe(0)
    expect(buildBudgetLineFields({ budgeted: '0', notes: '' }).budgeted).toBe(0)
  })

  it('does NOT silently turn junk into 0 — it produces NaN for validation to catch', () => {
    expect(buildBudgetLineFields({ budgeted: 'abc', notes: '' }).budgeted).toBeNaN()
  })

  it('trims notes and coerces a missing note to an empty string', () => {
    expect(buildBudgetLineFields({ budgeted: 1, notes: '  hello  ' }).notes).toBe('hello')
    expect(buildBudgetLineFields({ budgeted: 1 }).notes).toBe('')
    expect(buildBudgetLineFields({ budgeted: 1, notes: null }).notes).toBe('')
  })
})

describe('budgetLines — validateBudgetLine', () => {
  it('accepts a positive budget', () => {
    expect(validateBudgetLine({ budgeted: 12500, notes: '' })).toBeNull()
  })

  it('accepts ZERO — a reviewed allocation of nothing is a real value', () => {
    expect(validateBudgetLine({ budgeted: 0, notes: '' })).toBeNull()
  })

  it('accepts a decimal budget', () => {
    expect(validateBudgetLine({ budgeted: 1234.56, notes: '' })).toBeNull()
  })

  it('rejects a negative budget', () => {
    expect(validateBudgetLine({ budgeted: -1, notes: '' })).toMatch(/cannot be negative/i)
    expect(validateBudgetLine({ budgeted: -0.01, notes: '' })).toMatch(/cannot be negative/i)
  })

  it('rejects blank, null and undefined rather than defaulting them to 0', () => {
    for (const blank of ['', null, undefined]) {
      expect(validateBudgetLine({ budgeted: blank, notes: '' })).toMatch(/must be a number/i)
    }
  })

  it('rejects non-numeric and non-finite input', () => {
    for (const junk of ['abc', NaN, Infinity, -Infinity, {}, []]) {
      expect(validateBudgetLine({ budgeted: junk, notes: '' })).toMatch(/must be a number/i)
    }
  })

  it('bounds the notes length', () => {
    expect(validateBudgetLine({ budgeted: 1, notes: 'x'.repeat(BUDGET_LINE_NOTES_MAX_LENGTH) })).toBeNull()
    expect(validateBudgetLine({ budgeted: 1, notes: 'x'.repeat(BUDGET_LINE_NOTES_MAX_LENGTH + 1) }))
      .toMatch(/characters or fewer/i)
  })

  it('composes with buildBudgetLineFields — junk in, error out', () => {
    expect(validateBudgetLine(buildBudgetLineFields({ budgeted: 'oops', notes: '' })))
      .toMatch(/must be a number/i)
    expect(validateBudgetLine(buildBudgetLineFields({ budgeted: '12500', notes: '' }))).toBeNull()
  })
})

describe('budgetLines — budgetLineToForm', () => {
  it('renders a stored 0 as "0", not as blank', () => {
    // A budget of zero must not open looking unset.
    expect(budgetLineToForm({ budgeted: 0, notes: '' })).toEqual({ budgeted: '0', notes: '' })
  })

  it('stringifies a stored number', () => {
    expect(budgetLineToForm({ budgeted: 12500, notes: 'n' })).toEqual({ budgeted: '12500', notes: 'n' })
  })

  it('maps a missing or null budget to an empty string', () => {
    expect(budgetLineToForm({ notes: '' }).budgeted).toBe('')
    expect(budgetLineToForm({ budgeted: null, notes: '' }).budgeted).toBe('')
  })

  it('maps a non-string note to an empty string', () => {
    expect(budgetLineToForm({ budgeted: 1, notes: null }).notes).toBe('')
    expect(budgetLineToForm({ budgeted: 1 }).notes).toBe('')
  })

  it('maps a legacy or non-object line to a blank form rather than throwing', () => {
    expect(budgetLineToForm(null)).toEqual({ budgeted: '', notes: '' })
    expect(budgetLineToForm(undefined)).toEqual({ budgeted: '', notes: '' })
    expect(budgetLineToForm('nonsense')).toEqual({ budgeted: '', notes: '' })
  })

  it('never surfaces the cost code into the editable form values', () => {
    const form = budgetLineToForm({ budgeted: 1, notes: '', costCodeId: 'cc1', costCodeName: 'x' })
    expect(Object.keys(form).sort()).toEqual(['budgeted', 'notes'])
  })

  it('round-trips a stored line through the form and back unchanged', () => {
    const stored = { budgeted: 12500, notes: 'Slab package' }
    const built = buildBudgetLineFields(budgetLineToForm(stored))
    expect(built).toEqual({ budgeted: 12500, notes: 'Slab package' })
  })
})
