// ── Project directory backfill — PURE planning (M2-A2) ───────────────────────
//
// A directory entry (companies/{c}/projectDirectory/{projectId}) is the
// external-safe copy of FIVE display fields of a project. firestore.rules pins
// every client write of it to the project document; this module decides what a
// backfill would write for a project that pre-dates the directory, using the
// SAME defaults the rules use for an absent field.
//
// Nothing here touches Firestore. `isTimestamp` is injected so the functions
// are testable without the Admin SDK.

export const DIRECTORY_KEYS = ['name', 'status', 'location', 'startDate', 'progress']

const defaultIsTimestamp = (v) => !!v && typeof v === 'object' && typeof v.toMillis === 'function' && typeof v.isEqual === 'function'

// The entry a project SHOULD have, or the reasons it cannot have one. A source
// value of the wrong type is REPORTED, never coerced: the rules would refuse
// the entry, and a guessed value would be a projection nobody approved.
export function expectedEntry(project, isTimestamp = defaultIsTimestamp) {
  const p = project ?? {}
  const entry = {
    name:      p.name ?? '',
    status:    p.status ?? '',
    location:  p.location ?? '',
    startDate: p.startDate ?? null,
    progress:  p.progress ?? 0,
  }
  const problems = []
  for (const k of ['name', 'status', 'location']) {
    if (typeof entry[k] !== 'string') problems.push(`${k} is ${describe(entry[k])}, expected a string`)
  }
  if (entry.startDate !== null && !isTimestamp(entry.startDate)) problems.push(`startDate is ${describe(entry.startDate)}, expected a Timestamp or null`)
  if (typeof entry.progress !== 'number' || !Number.isFinite(entry.progress)) problems.push(`progress is ${describe(entry.progress)}, expected a number`)
  return { entry, problems }
}

// The differences between an EXISTING entry and the expected one ([] = in
// sync). An extra key is a difference: an entry holds the five keys only.
export function entryDifferences(existing, expected, isTimestamp = defaultIsTimestamp) {
  const diffs = []
  const e = existing ?? {}
  for (const k of Object.keys(e)) {
    if (!DIRECTORY_KEYS.includes(k)) diffs.push(`unexpected key "${k}"`)
  }
  for (const k of DIRECTORY_KEYS) {
    if (!(k in e)) { diffs.push(`${k} is missing`); continue }
    const a = e[k], b = expected[k]
    const same = isTimestamp(a) && isTimestamp(b) ? a.isEqual(b) : a === b
    if (!same) diffs.push(`${k} differs from the project`)
  }
  return diffs
}

function describe(v) {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'an array'
  return `a ${typeof v}`
}
