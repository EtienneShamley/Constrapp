import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  LAST_CHANGE_AUTHOR, stampToDate, lastChange, lastChangeText, formatChangeTime,
} from '../../src/lib/activityLastChange'
import { PROGRAMME_READ_ROLES, PROGRAMME_WRITE_ROLES } from '../../src/lib/projectTimeline'

// ── GANTT core completion G3 — last change visibility (ADR-79) ───────────────
//
// lib/activityLastChange.js reads the two stamps every activity write already
// sets (`updatedAt`, `updatedBy`) and says only what they support. These
// tests pin: valid timestamps; the viewer's own change; another user's;
// missing, pending and malformed metadata; that no name is ever produced;
// and that the row is shown to read-only roles without any new read.

const read = (rel) => readFileSync(fileURLToPath(new URL(`../../src/${rel}`, import.meta.url)), 'utf8')
const stripComments = (src) =>
  src.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

// 2026-11-20T03:14:00Z
const SECONDS = Date.UTC(2026, 10, 20, 3, 14, 0) / 1000
const timestamp = (seconds, nanoseconds = 0) => ({ seconds, nanoseconds, toDate: () => new Date(seconds * 1000 + nanoseconds / 1e6) })
const UTC = { timeZone: 'UTC' }

describe('the time: a real instant or nothing', () => {
  it('reads a Firestore Timestamp and the plain { seconds, nanoseconds } shape', () => {
    expect(stampToDate(timestamp(SECONDS)).toISOString()).toBe('2026-11-20T03:14:00.000Z')
    expect(stampToDate({ seconds: SECONDS, nanoseconds: 500_000_000 }).toISOString()).toBe('2026-11-20T03:14:00.500Z')
    expect(stampToDate({ seconds: SECONDS }).toISOString()).toBe('2026-11-20T03:14:00.000Z')
  })

  it('anything else is null — never the current time', () => {
    for (const bad of [null, undefined, '', 0, '2026-11-20', 1763608440, {}, { seconds: 'x' }, { seconds: NaN }, { seconds: Infinity },
      { toDate: () => new Date('nope') }, { toDate: () => 'yesterday' }, { toDate: () => { throw new Error('x') } }]) {
      expect(stampToDate(bad), JSON.stringify(bad)).toBeNull()
    }
  })

  it('is formatted with the date, the time and the zone', () => {
    const text = formatChangeTime(new Date(SECONDS * 1000), UTC)
    expect(text).toMatch(/20 Nov 2026/)
    expect(text).toMatch(/0?3:14/)
    expect(text).toMatch(/UTC|GMT/)
  })
})

describe('who: you, another user, or unknown — never a name', () => {
  const activity = { id: 'a', updatedAt: timestamp(SECONDS), updatedBy: 'uid_pm' }

  it('the current user\'s own change', () => {
    const c = lastChange(activity, { currentUid: 'uid_pm' })
    expect(c).toMatchObject({ timeKnown: true, author: LAST_CHANGE_AUTHOR.YOU, authorKnown: true, known: true, timePending: false })
    expect(c.at.toISOString()).toBe('2026-11-20T03:14:00.000Z')
    expect(lastChangeText(c, UTC)).toMatch(/^20 Nov 2026.* by you$/)
  })

  it('another user\'s change', () => {
    const c = lastChange(activity, { currentUid: 'uid_admin' })
    expect(c.author).toBe(LAST_CHANGE_AUTHOR.OTHER)
    expect(lastChangeText(c, UTC)).toMatch(/^20 Nov 2026.* by another user$/)
  })

  it('with no signed-in uid to compare, a recorded author is "another user" — never assumed to be the viewer', () => {
    for (const currentUid of [null, undefined, '']) {
      expect(lastChange(activity, { currentUid }).author).toBe(LAST_CHANGE_AUTHOR.OTHER)
    }
    expect(lastChange(activity).author).toBe(LAST_CHANGE_AUTHOR.OTHER)
  })

  it('a known time with no recorded author says so', () => {
    for (const updatedBy of [undefined, null, '', 42, {}]) {
      const c = lastChange({ updatedAt: timestamp(SECONDS), updatedBy }, { currentUid: 'uid_pm' })
      expect(c).toMatchObject({ timeKnown: true, author: LAST_CHANGE_AUTHOR.UNKNOWN, authorKnown: false, known: true })
      expect(lastChangeText(c, UTC)).toMatch(/^20 Nov 2026.* · author not recorded$/)
    }
  })

  it('an empty uid never matches an empty current uid', () => {
    expect(lastChange({ updatedAt: timestamp(SECONDS), updatedBy: '' }, { currentUid: '' }).author).toBe(LAST_CHANGE_AUTHOR.UNKNOWN)
  })
})

describe('missing, pending and legacy metadata', () => {
  it('nothing recorded at all', () => {
    for (const a of [null, undefined, {}, { id: 'legacy', name: 'Old' }, { updatedAt: 'x', updatedBy: 7 }]) {
      const c = lastChange(a, { currentUid: 'uid_pm' })
      expect(c).toMatchObject({ at: null, timeKnown: false, author: LAST_CHANGE_AUTHOR.UNKNOWN, known: false })
      expect(lastChangeText(c)).toBe('Not recorded for this activity.')
    }
    expect(lastChangeText(null)).toBe('Not recorded for this activity.')
  })

  it('a write the server has not confirmed yet (updatedAt null) is said as a possibility, with no time', () => {
    const c = lastChange({ updatedAt: null, updatedBy: 'uid_pm' }, { currentUid: 'uid_pm' })
    expect(c).toMatchObject({ at: null, timeKnown: false, timePending: true, author: LAST_CHANGE_AUTHOR.YOU, known: true })
    expect(lastChangeText(c)).toBe('By you · time not available yet — a save may still be in progress')
    expect(lastChangeText(lastChange({ updatedAt: null, updatedBy: 'uid_x' }, { currentUid: 'uid_pm' })))
      .toBe('By another user · time not available yet — a save may still be in progress')
  })

  it('an author with an absent or malformed time: the time is "not recorded"', () => {
    for (const updatedAt of [undefined, 'yesterday', { seconds: 'x' }]) {
      const c = lastChange({ updatedAt, updatedBy: 'uid_x' }, { currentUid: 'uid_pm' })
      expect(c).toMatchObject({ timeKnown: false, timePending: false, known: true })
      expect(lastChangeText(c)).toBe('By another user · time not recorded')
    }
  })

  it('no text ever contains a uid, an email or a guessed date', () => {
    const cases = [
      lastChange({ updatedAt: timestamp(SECONDS), updatedBy: 'uid_SECRET_123' }, { currentUid: 'uid_me' }),
      lastChange({ updatedAt: null, updatedBy: 'uid_SECRET_123' }, { currentUid: 'uid_me' }),
      lastChange({ updatedBy: 'uid_SECRET_123' }, {}),
      lastChange({}, { currentUid: 'uid_SECRET_123' }),
    ]
    for (const c of cases) {
      const text = lastChangeText(c, UTC)
      expect(text).not.toMatch(/uid_|SECRET|@/)
    }
    // Without a time there is no year in the sentence at all.
    for (const c of cases.slice(1)) expect(lastChangeText(c, UTC)).not.toMatch(/\b20\d\d\b/)
  })

  it('the helper does not mutate the activity and reads only the two stamps', () => {
    const a = Object.freeze({ id: 'a', name: 'Slab', createdBy: 'uid_creator', createdAt: timestamp(1), updatedAt: Object.freeze({ seconds: SECONDS, nanoseconds: 0 }), updatedBy: 'uid_pm' })
    expect(() => lastChange(a, { currentUid: 'uid_creator' })).not.toThrow()
    // The creator is NOT presented as the last author.
    expect(lastChange(a, { currentUid: 'uid_creator' }).author).toBe(LAST_CHANGE_AUTHOR.OTHER)
    const src = stripComments(read('lib/activityLastChange.js'))
    expect(src).not.toMatch(/createdAt|createdBy|cancelledBy|approvedBy|displayName|email/)
  })
})

describe('the module and the row: no lookup, no audit trail, no clock', () => {
  const lib = stripComments(read('lib/activityLastChange.js'))
  const row = stripComments(read('pages/project/timeline/LastChanged.jsx'))

  it('pure: no Firebase, no React, no clock of its own', () => {
    expect(lib).not.toMatch(/firebase|firestore|from 'react|getDoc|onSnapshot|Date\.now|new Date\(\)/)
  })

  it('the row performs no read and no user lookup', () => {
    expect(row).not.toMatch(/use[A-Z]\w*\(|firebase|getDoc|onSnapshot|useTeam|users\//)
    expect(row).toContain('const change = lastChange(activity, { currentUid })')
    expect(row).toContain('<time dateTime={change.at.toISOString()}>{lastChangeText(change)}</time>')
  })

  it('it is labelled as the last change only, not a history', () => {
    expect(row).toContain('The most recent saved change only — earlier changes and what was changed are not recorded.')
  })

  it('no audit collection was introduced', () => {
    const rules = readFileSync(fileURLToPath(new URL('../../firestore.rules', import.meta.url)), 'utf8')
    const hook = stripComments(read('hooks/useProjectActivities.jsx'))
    expect(rules).not.toMatch(/activityHistory|activityAudit|activityChanges/i)
    expect(hook).not.toMatch(/activityHistory|activityAudit|activityChanges/i)
    expect(hook.match(/onSnapshot\(/g)).toHaveLength(1)
  })
})

describe('where it is shown: the read-only detail and the editor', () => {
  const page = stripComments(read('pages/project/ProjectTimeline.jsx'))
  const detail = stripComments(read('pages/project/timeline/ActivityDetailModal.jsx'))
  const editor = stripComments(read('pages/project/timeline/ActivityEditorModal.jsx'))

  it('the read-only detail (QS, and anyone on a cancelled activity) shows the row', () => {
    expect(PROGRAMME_READ_ROLES).toEqual(['company_admin', 'project_manager', 'qs'])
    expect(PROGRAMME_WRITE_ROLES).not.toContain('qs')
    expect(detail).toContain('<Row label="Last changed"><LastChanged activity={a} currentUid={currentUid} /></Row>')
    // Still genuinely read-only: one Close button and no write path.
    expect(detail).not.toMatch(/onSave|onCancelActivity|type="submit"|<form|<input/)
    expect(detail.match(/<Btn /g)).toHaveLength(1)
  })

  it('the editor shows the stamps of the version the guarded save compares against', () => {
    expect(editor).toContain('<LastChanged activity={base} currentUid={currentUid} />')
    expect(editor).toContain('{!creating && (')
    // The guard itself is untouched: the save still hands `base` to the hook.
    expect(editor).toContain('const [base, setBase] = useState(activity ?? null)')
    expect(read('lib/activityActions.js')).toContain('if (!sameActivityVersion(seen, current)) return { kind: QUICK_ACTION_ERROR.STALE }')
  })

  it('the page passes only the signed-in uid — no profile, no team list', () => {
    expect(page.match(/currentUid=\{user\?\.uid \?\? null\}/g).length).toBeGreaterThanOrEqual(3)
    expect(page).not.toMatch(/useTeam|listMembers|users\//)
  })

  it('the role flags that gate writing are unchanged', () => {
    expect(page).toContain('const canRead  = canReadProgramme(role)')
    expect(page).toContain('const canWrite = canAuthorProgramme(role)')
    expect(page).toContain('if (canWrite && activity.status !== ACTIVITY_STATUS.CANCELLED) setEditing(activity)')
  })
})
