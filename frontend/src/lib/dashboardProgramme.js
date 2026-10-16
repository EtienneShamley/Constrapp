import {
  timelineSummary, isActivityStatus, nextMilestone,
  ACTIVITY_STATUS_ORDER, ACTIVITY_STATUS_LABELS,
} from './projectTimeline'

// ── Dashboard · Programme panel (read-time; NON-FINANCIAL) — ADR-45 ──────────
//
// The Dashboard's view of ONE selected project's programme (the Project
// Timeline `activities`, ADR-29). Every count comes from the existing
// `timelineSummary` — the same function behind the Timeline tab's summary
// cards — plus a per-status tally for the donut.
//
// ⚠️ WHAT THIS IS NOT. Activity status and dates are MANUALLY maintained and
// unverified. These are COUNTS of activities, not weighted progress, not earned
// value, not schedule performance against an approved baseline (Constrapp
// stores none), and not a health score. There is deliberately NO "% complete"
// figure anywhere in this module: "12 of 40 activities completed" is a count,
// and turning it into a percentage would read as project completion.
//
// No money, no currency, no Firestore, no React.

// Activities per status, in ACTIVITY_STATUS_ORDER. A stored status outside the
// vocabulary is counted under `other` rather than dropped, so the tally always
// sums to the activity total (the projectStatusCounts discipline).
export function activityStatusCounts(activities) {
  const counts = Object.fromEntries(ACTIVITY_STATUS_ORDER.map(s => [s, 0]))
  let other = 0
  for (const a of activities ?? []) {
    if (isActivityStatus(a?.status)) counts[a.status] += 1
    else other += 1
  }
  return {
    byStatus: ACTIVITY_STATUS_ORDER.map(status => ({
      status, label: ACTIVITY_STATUS_LABELS[status], count: counts[status],
    })),
    other,
  }
}

// Everything the panel shows. `summary` IS timelineSummary's output, unchanged.
// `nextMilestone` IS lib/projectTimeline.js → nextMilestone's output, unchanged:
// a named, dated milestone (upcoming, or the oldest overdue one when nothing is
// upcoming) — a date and a day count, never a percentage.
export function programmeOverview(activities, now = new Date()) {
  return {
    summary: timelineSummary(activities, now),
    ...activityStatusCounts(activities),
    nextMilestone: nextMilestone(activities, now),
  }
}

// Donut geometry over the status tally (presentation only). Each segment is an
// arc on a circle drawn with `pathLength="100"`, so `lengthPct` /
// `offsetPct` are percentages of the circumference. Zero-count statuses are
// omitted. No segment, and no centre figure, is a completion percentage.
export function donutSegments(byStatus, other = 0) {
  const entries = [...(byStatus ?? []), ...(other > 0 ? [{ status: 'other', label: 'Other status', count: other }] : [])]
  const total = entries.reduce((s, e) => s + (Number(e.count) || 0), 0)
  if (total <= 0) return { total: 0, segments: [] }
  let offset = 0
  const segments = []
  for (const e of entries) {
    const count = Number(e.count) || 0
    if (count <= 0) continue
    const lengthPct = count / total * 100
    segments.push({
      status: e.status, label: e.label, count, offsetPct: offset, lengthPct,
      // SVG stroke-dash values for a pathLength="100" ring.
      dashArray: `${lengthPct} ${100 - lengthPct}`,
      dashOffset: -offset,
    })
    offset += lengthPct
  }
  return { total, segments }
}
