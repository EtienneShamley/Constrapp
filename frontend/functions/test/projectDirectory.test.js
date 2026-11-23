import { describe, it, expect } from 'vitest'
import { DIRECTORY_KEYS, expectedEntry, entryDifferences } from '../scripts/_projectDirectory.mjs'

// ── Project directory backfill — the pure planning (M2-A2) ───────────────────
// The emulator run of the script itself is tests/functions/scripts.test.js.

const ts = (ms) => ({ toMillis: () => ms, isEqual: (o) => !!o && typeof o.toMillis === 'function' && o.toMillis() === ms })
const PROJECT = { name: 'Tower', status: 'In Progress', location: 'Brisbane', startDate: ts(1000), progress: 40, budget: 5000000, currency: 'AUD', currencyLocked: true, createdBy: 'u1' }

describe('expectedEntry', () => {
  it('takes exactly the five display fields — never the budget, currency or provenance', () => {
    const { entry, problems } = expectedEntry(PROJECT)
    expect(problems).toEqual([])
    expect(Object.keys(entry).sort()).toEqual([...DIRECTORY_KEYS].sort())
    expect(DIRECTORY_KEYS).toEqual(['name', 'status', 'location', 'startDate', 'progress'])
    expect(JSON.stringify(Object.keys(entry))).not.toMatch(/budget|currency|created/)
  })

  it('uses the defaults the rules use for an absent field: "" / null / 0', () => {
    expect(expectedEntry({ name: 'Bare' })).toEqual({ entry: { name: 'Bare', status: '', location: '', startDate: null, progress: 0 }, problems: [] })
    expect(expectedEntry({}).entry).toEqual({ name: '', status: '', location: '', startDate: null, progress: 0 })
    expect(expectedEntry(undefined).problems).toEqual([])
  })

  it('REPORTS a source value of the wrong type and never coerces it', () => {
    const bad = expectedEntry({ name: 42, status: ['x'], location: { a: 1 }, startDate: '2026-03-01', progress: '40' })
    expect(bad.problems).toHaveLength(5)
    expect(bad.problems.join(' | ')).toContain('name is a number, expected a string')
    expect(bad.problems.join(' | ')).toContain('status is an array')
    expect(bad.problems.join(' | ')).toContain('startDate is a string, expected a Timestamp or null')
    expect(bad.problems.join(' | ')).toContain('progress is a string, expected a number')
    expect(expectedEntry({ progress: NaN }).problems).toHaveLength(1)
    expect(expectedEntry({ progress: Infinity }).problems).toHaveLength(1)
    expect(expectedEntry({ startDate: { seconds: 1 } }).problems).toHaveLength(1)
  })
})

describe('entryDifferences', () => {
  const { entry } = expectedEntry(PROJECT)

  it('an identical entry has no differences (timestamps compared by value)', () => {
    expect(entryDifferences({ ...entry, startDate: ts(1000) }, entry)).toEqual([])
  })

  it('names each field that differs', () => {
    expect(entryDifferences({ ...entry, name: 'Other' }, entry)).toEqual(['name differs from the project'])
    expect(entryDifferences({ ...entry, startDate: ts(1001) }, entry)).toEqual(['startDate differs from the project'])
    expect(entryDifferences({ ...entry, startDate: null }, entry)).toEqual(['startDate differs from the project'])
    expect(entryDifferences({ ...entry, progress: '40' }, entry)).toEqual(['progress differs from the project'])
  })

  it('a missing key and an extra key are both differences — an entry holds the five keys only', () => {
    const withoutName = { ...entry }
    delete withoutName.name
    expect(entryDifferences(withoutName, entry)).toEqual(['name is missing'])
    expect(entryDifferences({ ...entry, budget: 5000000 }, entry)).toEqual(['unexpected key "budget"'])
    expect(entryDifferences({}, entry)).toHaveLength(5)
  })
})
