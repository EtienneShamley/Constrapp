import { describe, it, expect } from 'vitest'
import {
  PROJECT_STATUSES,
  PROJECT_EDITABLE_KEYS,
  PROJECT_NAME_MAX_LENGTH,
  PROJECT_LOCATION_MAX_LENGTH,
  isProjectStatus,
  clampProgress,
  buildProjectFields,
  validateProjectEdit,
  projectStartDateToInput,
} from '../../src/lib/projects'

// ── Project record — pure unit tests (ADR-39) ────────────────────────────────
//
// Exercises lib/projects.js as plain functions — no React, no Firebase, no
// emulator. The Firestore Rules suite is separate
// (tests/rules/projects.rules.test.js, npm run test:rules).
//
// The load-bearing contract proved here: the editable key set NEVER includes
// `budget`, `currency`, `currencyLocked`, `createdAt` or `createdBy`, and there
// is deliberately NO status transition graph — `status` is descriptive, so any
// value may move to any other, including reopening `Completed`.

// A minimal stand-in for a Firestore Timestamp: the only surface
// projectStartDateToInput touches is `.toDate()`.
const ts = (date) => ({ toDate: () => date })

describe('projects — status vocabulary', () => {
  it('is exactly the five existing display strings, in order', () => {
    expect(PROJECT_STATUSES).toEqual([
      'Planning', 'In Progress', 'Backlogged', 'On Hold', 'Completed',
    ])
  })

  it('recognises every valid status', () => {
    for (const s of PROJECT_STATUSES) expect(isProjectStatus(s)).toBe(true)
  })

  it('rejects near-misses, legacy slugs, and non-strings', () => {
    // 'in_progress' is the shape the rules suite's LEGACY_PROJECT fixture
    // stores — proof that documents outside the current vocabulary exist.
    for (const s of ['in_progress', 'in progress', 'INPROGRESS', 'Complete', '', null, undefined, 3]) {
      expect(isProjectStatus(s)).toBe(false)
    }
  })

  it('exports NO transition map — every status may move to every other', () => {
    // `status` gates no order, claim, invoice, variation, payment or rule
    // anywhere in the app. A transition graph would advertise a control that
    // does not exist, so validateProjectEdit never consults the previous value.
    for (const from of PROJECT_STATUSES) {
      for (const to of PROJECT_STATUSES) {
        expect(validateProjectEdit({ name: 'P', status: to, location: '' })).toBeNull()
        expect(from).toBeTruthy() // the "from" state is genuinely irrelevant
      }
    }
  })

  it('a Completed project may be reopened to any other status', () => {
    for (const to of PROJECT_STATUSES) {
      expect(validateProjectEdit({ name: 'Reopened', status: to, location: '' })).toBeNull()
    }
  })
})

describe('projects — editable key set', () => {
  it('is exactly the five metadata fields', () => {
    expect(PROJECT_EDITABLE_KEYS).toEqual(['name', 'status', 'startDate', 'location', 'progress'])
  })

  it('never includes the headline budget, the currency fields, or provenance', () => {
    for (const forbidden of ['budget', 'currency', 'currencyLocked', 'createdAt', 'createdBy']) {
      expect(PROJECT_EDITABLE_KEYS).not.toContain(forbidden)
    }
  })

  it('buildProjectFields emits ONLY the editable keys', () => {
    const built = buildProjectFields({
      name: 'A', status: 'Planning', startDate: '2026-01-01', location: 'B', progress: 10,
      // Everything below must be dropped on the floor.
      budget: 999999, currency: 'NZD', currencyLocked: false,
      createdAt: 'x', createdBy: 'y', id: 'z',
    })
    expect(Object.keys(built).sort()).toEqual([...PROJECT_EDITABLE_KEYS].sort())
  })
})

describe('projects — clampProgress', () => {
  it('passes through in-range values', () => {
    expect(clampProgress(0)).toBe(0)
    expect(clampProgress(35)).toBe(35)
    expect(clampProgress(100)).toBe(100)
  })

  it('clamps out-of-range values to the 0–100 bounds', () => {
    expect(clampProgress(-1)).toBe(0)
    expect(clampProgress(-9999)).toBe(0)
    expect(clampProgress(101)).toBe(100)
    expect(clampProgress(1e9)).toBe(100)
  })

  it('coerces numeric strings, matching the create path', () => {
    expect(clampProgress('45')).toBe(45)
    expect(clampProgress('  45  ')).toBe(45)
  })

  it('maps junk, blank, null and non-finite input to 0 rather than NaN', () => {
    for (const junk of ['', '  ', 'abc', null, undefined, NaN, Infinity, -Infinity, {}]) {
      expect(clampProgress(junk)).toBe(0)
    }
  })
})

describe('projects — buildProjectFields', () => {
  it('trims name and location', () => {
    const built = buildProjectFields({
      name: '  Lakeside Apartments  ', status: 'Planning',
      startDate: '', location: '  Brisbane QLD  ', progress: 0,
    })
    expect(built.name).toBe('Lakeside Apartments')
    expect(built.location).toBe('Brisbane QLD')
  })

  it('maps a blank start date to NULL, not to an empty string', () => {
    // The stored field is `Timestamp | null`; clearing must restore exactly the
    // state of a project created with no start date.
    for (const blank of ['', null, undefined]) {
      expect(buildProjectFields({
        name: 'P', status: 'Planning', startDate: blank, location: '', progress: 0,
      }).startDate).toBeNull()
    }
  })

  it('preserves a supplied start date as a YYYY-MM-DD string', () => {
    expect(buildProjectFields({
      name: 'P', status: 'Planning', startDate: '2026-03-01', location: '', progress: 0,
    }).startDate).toBe('2026-03-01')
  })

  it('clamps progress and coerces missing name/location to empty strings', () => {
    const built = buildProjectFields({ status: 'On Hold', progress: 250 })
    expect(built).toEqual({
      name: '', status: 'On Hold', startDate: null, location: '', progress: 100,
    })
  })
})

describe('projects — validateProjectEdit', () => {
  const ok = { name: 'Lakeside', status: 'In Progress', location: 'Brisbane' }

  it('accepts a well-formed edit', () => {
    expect(validateProjectEdit(ok)).toBeNull()
  })

  it('requires a non-blank name', () => {
    expect(validateProjectEdit({ ...ok, name: '' })).toMatch(/name is required/i)
    expect(validateProjectEdit({ ...ok, name: '   ' })).toMatch(/name is required/i)
    expect(validateProjectEdit({ ...ok, name: null })).toMatch(/name is required/i)
  })

  it('bounds the name length', () => {
    expect(validateProjectEdit({ ...ok, name: 'x'.repeat(PROJECT_NAME_MAX_LENGTH) })).toBeNull()
    expect(validateProjectEdit({ ...ok, name: 'x'.repeat(PROJECT_NAME_MAX_LENGTH + 1) }))
      .toMatch(/characters or fewer/i)
  })

  it('bounds the location length and allows a blank location', () => {
    expect(validateProjectEdit({ ...ok, location: '' })).toBeNull()
    expect(validateProjectEdit({ ...ok, location: 'x'.repeat(PROJECT_LOCATION_MAX_LENGTH) })).toBeNull()
    expect(validateProjectEdit({ ...ok, location: 'x'.repeat(PROJECT_LOCATION_MAX_LENGTH + 1) }))
      .toMatch(/characters or fewer/i)
  })

  it('rejects a status outside the five-value vocabulary', () => {
    expect(validateProjectEdit({ ...ok, status: 'in_progress' })).toMatch(/valid project status/i)
    expect(validateProjectEdit({ ...ok, status: 'Archived' })).toMatch(/valid project status/i)
    expect(validateProjectEdit({ ...ok, status: undefined })).toMatch(/valid project status/i)
  })
})

describe('projects — projectStartDateToInput', () => {
  it('formats a Timestamp as the YYYY-MM-DD an <input type="date"> needs', () => {
    expect(projectStartDateToInput(ts(new Date(2026, 2, 9)))).toBe('2026-03-09')
  })

  it('zero-pads single-digit months and days', () => {
    expect(projectStartDateToInput(ts(new Date(2026, 0, 5)))).toBe('2026-01-05')
  })

  it('returns "" for a project with no start date', () => {
    expect(projectStartDateToInput(null)).toBe('')
    expect(projectStartDateToInput(undefined)).toBe('')
  })

  it('returns "" rather than throwing for a malformed legacy value', () => {
    // A raw string, a number, or a Timestamp yielding an Invalid Date must open
    // the editor blank instead of crashing the modal.
    expect(projectStartDateToInput('2026-03-09')).toBe('')
    expect(projectStartDateToInput(12345)).toBe('')
    expect(projectStartDateToInput(ts(new Date('nonsense')))).toBe('')
  })

  it('round-trips through buildProjectFields unchanged', () => {
    const input = projectStartDateToInput(ts(new Date(2026, 6, 21)))
    expect(buildProjectFields({
      name: 'P', status: 'Planning', startDate: input, location: '', progress: 0,
    }).startDate).toBe('2026-07-21')
  })
})
