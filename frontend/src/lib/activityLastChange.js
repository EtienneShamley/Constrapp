// ── Constrap GANTT™ — last change of an activity (ADR-79) ────────────────────
//
// PURE. No Firestore, no React, no clock. Reads the two stamps EVERY activity
// write already sets (lib/activityActions.js, lib/activityQuickActions.js;
// rules-enforced):
//
//   updatedAt   the server time of the last write
//   updatedBy   the uid that made it
//
// and says only what those two fields support.
//
// ⚠️ NO NAME IS EVER SHOWN, because none is stored and `users/{uid}` is
// readable by its owner only. The author is therefore one of three things:
// the viewer themself (the uid matches), another user (a uid that does not),
// or unknown (no uid). Nothing is looked up and nothing is inferred.
//
// ⚠️ THIS IS THE LAST CHANGE, NOT A HISTORY. There is no audit collection:
// one write replaces the stamps of the one before it, and what changed is not
// recorded. Never describe this as a change log.
//
// `updatedAt` reads as null while a write is still being confirmed by the
// server, and may be absent or malformed on a record written outside the app.
// In every such case the time is reported as not available — never guessed,
// and never replaced by the viewer's clock.

export const LAST_CHANGE_AUTHOR = {
  YOU:     'you',
  OTHER:   'other',
  UNKNOWN: 'unknown',
}

// A Firestore Timestamp (or its plain { seconds, nanoseconds } shape) → Date,
// or null for anything that is not a real instant.
export function stampToDate(ts) {
  if (!ts) return null
  let d = null
  if (typeof ts.toDate === 'function') {
    try { d = ts.toDate() } catch { d = null }
  } else if (typeof ts.seconds === 'number' && Number.isFinite(ts.seconds)) {
    d = new Date(ts.seconds * 1000 + Math.floor((Number(ts.nanoseconds) || 0) / 1e6))
  }
  return d instanceof Date && !Number.isNaN(d.getTime()) ? d : null
}

export function lastChange(activity, { currentUid = null } = {}) {
  const at = stampToDate(activity?.updatedAt)
  const uid = typeof activity?.updatedBy === 'string' && activity.updatedBy ? activity.updatedBy : null
  const author = !uid
    ? LAST_CHANGE_AUTHOR.UNKNOWN
    : (currentUid && uid === currentUid ? LAST_CHANGE_AUTHOR.YOU : LAST_CHANGE_AUTHOR.OTHER)
  return {
    at,
    timeKnown: at !== null,
    // An explicit null is what the SDK reports for a server time it has not
    // confirmed yet — said as a possibility, never asserted.
    timePending: at === null && activity?.updatedAt === null,
    author,
    authorKnown: author !== LAST_CHANGE_AUTHOR.UNKNOWN,
    known: at !== null || author !== LAST_CHANGE_AUTHOR.UNKNOWN,
  }
}

const AUTHOR_TEXT = {
  [LAST_CHANGE_AUTHOR.YOU]:   'by you',
  [LAST_CHANGE_AUTHOR.OTHER]: 'by another user',
}

// 20 Nov 2026, 2:14 pm AEDT — the viewer's own locale zone unless one is
// injected (the unit suite pins it).
export function formatChangeTime(date, { timeZone } = {}) {
  return date.toLocaleString('en-AU', {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
    ...(timeZone ? { timeZone } : {}),
  })
}

// The one sentence shown in the detail and the editor.
export function lastChangeText(change, { timeZone } = {}) {
  if (!change || !change.known) return 'Not recorded for this activity.'
  const who = AUTHOR_TEXT[change.author] ?? ''
  if (change.timeKnown) {
    const when = formatChangeTime(change.at, { timeZone })
    return who ? `${when} ${who}` : `${when} · author not recorded`
  }
  const time = change.timePending
    ? 'time not available yet — a save may still be in progress'
    : 'time not recorded'
  return `${who.charAt(0).toUpperCase()}${who.slice(1)} · ${time}`
}
