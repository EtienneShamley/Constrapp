import { lastChange, lastChangeText } from '../../../lib/activityLastChange'

// ── "Last changed" for one activity (ADR-79) ─────────────────────────────────
//
// The existing `updatedAt` / `updatedBy` stamps, said plainly. PRESENTATION
// ONLY over lib/activityLastChange.js: no read, no lookup, no name — "you" or
// "another user", because no name is stored and users/{uid} is owner-read
// only. It is the LAST change, not a history; the caption says so.

export default function LastChanged({ activity, currentUid, className = '' }) {
  const change = lastChange(activity, { currentUid })
  return (
    <span className={className}>
      {change.timeKnown
        ? <time dateTime={change.at.toISOString()}>{lastChangeText(change)}</time>
        : <span className="text-brand-muted">{lastChangeText(change)}</span>}
      <span className="block text-[10.5px] text-brand-muted">
        The most recent saved change only — earlier changes and what was changed are not recorded.
      </span>
    </span>
  )
}
