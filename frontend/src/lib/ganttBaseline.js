import {
  ACTIVITY_STATUS, isActivityStatus, isValidIsoDate, daysBetween, formatIsoDate,
  compareActivities, activityRevision,
} from './projectTimeline'

// ── Constrapp GANTT™ programme baselines (Programme 1B, ADR-66) ──────────────
//
// PURE. No Firestore, no React, no clock. Everything an approved programme
// baseline needs that is not a write: the capture projection and its
// validation, the payload size estimate, version selection (active /
// original), drift between a captured snapshot and the live programme, the
// per-activity variance and the summary counts.
//
// A BASELINE is a formally captured and approved programme — the planned
// dates as they stood when someone approved them. It lives in TWO documents
// written together (lib/programmeBaselineActions.js): a small lifecycle
// HEADER (`programmeBaselines/{id}`) and ONE immutable SNAPSHOT
// (`programmeBaselineSnapshots/{id}`) holding a bounded list of minimal
// activity entries. Nothing here is ever inferred from an activity's first
// saved date, and nothing here moves a current date.
//
// ⚠️ THE CURRENT PROGRAMME STAYS THE CURRENT PROGRAMME. `isOverdue`, the
// dependency states and the recorded-dates comparison in lib/timelineGantt.js
// are unchanged and still measure against the CURRENT plan. The variance
// below is a SEPARATE measure against the SELECTED APPROVED baseline; the
// four are never merged into one "delay" figure.
//
// ⚠️ NOT A CONTRACTUAL DETERMINATION. An approved programme baseline is
// planning evidence. It is not an extension-of-time entitlement, a
// contractual programme acceptance or a delay determination, and nothing in
// this module should be described as one.
//
// ⚠️ NO FINANCIAL FIELD, NO FINANCIAL EFFECT. An entry holds dates, status,
// progress, the activity's revision and its cost-code JOIN KEY only; the
// programme still writes no financial document and the baseline reads none.

// ── Header lifecycle ─────────────────────────────────────────────────────────

export const BASELINE_STATUS = {
  DRAFT:     'draft',
  APPROVED:  'approved',
  WITHDRAWN: 'withdrawn',
}

export const BASELINE_STATUS_ORDER = [BASELINE_STATUS.DRAFT, BASELINE_STATUS.APPROVED, BASELINE_STATUS.WITHDRAWN]

export const BASELINE_STATUS_LABELS = {
  [BASELINE_STATUS.DRAFT]:     'Draft',
  [BASELINE_STATUS.APPROVED]:  'Approved',
  [BASELINE_STATUS.WITHDRAWN]: 'Withdrawn',
}

// Badge variants from the existing design system — never a new colour.
export const BASELINE_STATUS_BADGE = {
  [BASELINE_STATUS.DRAFT]:     'pending',
  [BASELINE_STATUS.APPROVED]:  'active',
  [BASELINE_STATUS.WITHDRAWN]: 'soon',
}

export const isBaselineStatus = (s) => BASELINE_STATUS_ORDER.includes(s)

// draft → approved, draft → withdrawn. Approved and withdrawn are TERMINAL:
// an approved baseline is never edited, withdrawn or deleted (ADR-66).
export function canBaselineTransition(from, to) {
  if (from !== BASELINE_STATUS.DRAFT) return false
  return to === BASELINE_STATUS.APPROVED || to === BASELINE_STATUS.WITHDRAWN
}

export const BASELINE_LIMITS = {
  name: 120,
  reason: 500,
  withdrawReason: 500,
  // The application entry ceiling (rules-pinned). Subject to the document
  // size margin below — the smaller of the two wins.
  entries: 2000,
}

// Cloud Firestore refuses a document above 1 MiB. The capture is refused
// well below that so a realistic worst case (long names on every line) can
// never be written half-way — there is no half-way: one document, or none.
export const FIRESTORE_DOCUMENT_MAX_BYTES = 1_048_576
export const SNAPSHOT_MAX_BYTES = 900_000

// EXACTLY the stored entry keys (rules pin this shape on the first and last
// entries; the app writes every entry this way).
export const ENTRY_KEYS = [
  'activityId', 'name', 'isMilestone', 'plannedStart', 'plannedFinish',
  'status', 'percentComplete', 'revision', 'sortOrder', 'costCodeId',
]

const trimTo = (v, max) => String(v ?? '').trim().slice(0, max)

export function validateBaselineDraft({ name, reason } = {}) {
  const n = String(name ?? '').trim()
  if (!n) return 'Enter a name for this baseline'
  if (n.length > BASELINE_LIMITS.name) return `The name must be ${BASELINE_LIMITS.name} characters or fewer`
  const r = String(reason ?? '').trim()
  if (!r) return 'Enter the reason this programme is being baselined'
  if (r.length > BASELINE_LIMITS.reason) return `The reason must be ${BASELINE_LIMITS.reason} characters or fewer`
  return null
}

export function normaliseBaselineDraft({ name, reason } = {}) {
  return { name: trimTo(name, BASELINE_LIMITS.name), reason: trimTo(reason, BASELINE_LIMITS.reason) }
}

export function validateWithdrawReason(reason) {
  const r = String(reason ?? '').trim()
  if (!r) return 'Enter a reason for withdrawing this draft'
  if (r.length > BASELINE_LIMITS.withdrawReason) {
    return `The reason must be ${BASELINE_LIMITS.withdrawReason} characters or fewer`
  }
  return null
}

// ── Capture projection ───────────────────────────────────────────────────────
//
// ONE entry per activity, the minimal planning fields only. The projection
// never repairs a record: validation (below) refuses the capture and names
// the activity, so nothing is ever silently excluded or truncated.

export function projectBaselineEntry(activity) {
  const a = activity ?? {}
  return {
    activityId:      typeof a.id === 'string' ? a.id : '',
    name:            typeof a.name === 'string' ? a.name : '',
    isMilestone:     a.isMilestone === true,
    plannedStart:    typeof a.plannedStart === 'string' ? a.plannedStart : '',
    plannedFinish:   typeof a.plannedFinish === 'string' ? a.plannedFinish : '',
    status:          a.status,
    percentComplete: a.percentComplete,
    revision:        activityRevision(a),
    sortOrder:       a.sortOrder,
    costCodeId:      typeof a.costCodeId === 'string' && a.costCodeId ? a.costCodeId : null,
  }
}

// Why an entry may NOT be captured (a user sentence), or null.
export function validateBaselineEntry(entry) {
  const e = entry ?? {}
  if (!e.activityId) return 'has no document id'
  if (!String(e.name ?? '').trim()) return 'has no name'
  if (String(e.name).length > 120) return 'has a name longer than 120 characters'
  if (!isActivityStatus(e.status)) return 'has an unrecognised status'
  if (!isValidIsoDate(e.plannedStart)) return e.isMilestone ? 'has no usable milestone date' : 'has no usable planned start'
  if (!isValidIsoDate(e.plannedFinish)) return 'has no usable planned finish'
  if (e.plannedFinish < e.plannedStart) return 'has a planned finish before its planned start'
  if (e.isMilestone && e.plannedFinish !== e.plannedStart) return 'is a milestone with two different dates'
  if (!Number.isInteger(e.percentComplete) || e.percentComplete < 0 || e.percentComplete > 100) {
    return 'has progress outside 0–100'
  }
  if (!Number.isInteger(e.revision) || e.revision < 1) return 'has no usable revision'
  if (!Number.isFinite(e.sortOrder)) return 'has no usable programme order'
  if (e.costCodeId !== null && (typeof e.costCodeId !== 'string' || !e.costCodeId)) return 'has a malformed cost code link'
  return null
}

// ── Firestore storage size (the documented formula) ──────────────────────────
//
// Firestore's document size: for every field, the UTF-8 size of its name + 1,
// plus the value — a string is its UTF-8 size + 1, a number 8 bytes, a
// boolean 1, null 1, an array the sum of its elements, a map the sum of its
// fields — plus the document name and 32 bytes. Estimated here so an
// oversized capture is refused BEFORE a write is attempted.

const utf8Bytes = (s) => {
  let n = 0
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i)
    if (c < 0x80) n += 1
    else if (c < 0x800) n += 2
    else if (c >= 0xd800 && c <= 0xdbff) { n += 4; i += 1 }
    else n += 3
  }
  return n
}

export function firestoreValueBytes(v) {
  if (v === null || v === undefined) return 1
  if (typeof v === 'boolean') return 1
  if (typeof v === 'number') return 8
  if (typeof v === 'string') return utf8Bytes(v) + 1
  if (Array.isArray(v)) return v.reduce((s, x) => s + firestoreValueBytes(x), 0)
  if (typeof v === 'object') {
    // A Timestamp (or any other object) is treated as 8 bytes; a plain map
    // is the sum of its fields.
    if (typeof v.seconds === 'number' || typeof v.toDate === 'function') return 8
    return Object.entries(v).reduce((s, [k, x]) => s + utf8Bytes(k) + 1 + firestoreValueBytes(x), 0)
  }
  return 8
}

// A generous allowance for the document name
// (companies/{c}/projects/{p}/programmeBaselineSnapshots/{id}).
export const SNAPSHOT_PATH_BYTES = 200

export function estimateSnapshotBytes(entries, { capturedBy = '', pathBytes = SNAPSHOT_PATH_BYTES } = {}) {
  const doc = {
    activityCount: (entries ?? []).length,
    capturedAt: 0,
    capturedBy,
    activities: entries ?? [],
  }
  return firestoreValueBytes(doc) + pathBytes + 32
}

// ── Capture payload ──────────────────────────────────────────────────────────
//
// Builds EXACTLY what the snapshot document will hold, from the activities
// the caller read — the action layer passes a FRESH SERVER read, never the
// listener. Every activity (including cancelled history) is projected; any
// activity that fails validation, or a duplicate id, REFUSES the whole
// capture with the offending records named. Never a partial list.

export function buildCapturePayload(activities, { capturedBy = '' } = {}) {
  const ordered = [...(activities ?? [])].sort(compareActivities)
  const entries = []
  const errors = []
  const seen = new Set()
  let cancelledAtCapture = 0
  let milestones = 0

  for (const a of ordered) {
    const entry = projectBaselineEntry(a)
    const problem = validateBaselineEntry(entry)
    const label = entry.name || entry.activityId || 'An activity'
    if (problem) { errors.push({ activityId: entry.activityId, name: label, reason: `${label} ${problem}` }); continue }
    if (seen.has(entry.activityId)) {
      errors.push({ activityId: entry.activityId, name: label, reason: `${label} appears twice in the programme read` })
      continue
    }
    seen.add(entry.activityId)
    if (entry.status === ACTIVITY_STATUS.CANCELLED) cancelledAtCapture += 1
    if (entry.isMilestone) milestones += 1
    entries.push(entry)
  }

  const counts = {
    total: ordered.length,
    captured: entries.length,
    live: entries.length - cancelledAtCapture,
    cancelledAtCapture,
    milestones,
    invalid: errors.length,
  }
  const bytes = estimateSnapshotBytes(entries, { capturedBy })

  let refusal = null
  if (errors.length > 0) {
    refusal = `${errors.length} ${errors.length === 1 ? 'activity cannot' : 'activities cannot'} be captured as stored. Correct ${errors.length === 1 ? 'it' : 'them'} in the programme and try again — nothing is excluded silently.`
  } else if (entries.length === 0) {
    refusal = 'There are no activities to capture.'
  } else if (entries.length > BASELINE_LIMITS.entries) {
    refusal = `A baseline may hold at most ${BASELINE_LIMITS.entries} activities; this programme has ${entries.length}. Nothing was written.`
  } else if (bytes > SNAPSHOT_MAX_BYTES) {
    refusal = `This programme's baseline would be about ${Math.round(bytes / 1024)} KB, above the ${Math.round(SNAPSHOT_MAX_BYTES / 1024)} KB a single baseline may hold. Nothing was written and nothing was truncated.`
  }

  return { ok: refusal === null, entries, errors, counts, bytes, byteCeiling: SNAPSHOT_MAX_BYTES, refusal }
}

// ── Versions: approved history, active and original ──────────────────────────

const tsMillis = (t) => {
  if (!t) return null
  if (typeof t.toMillis === 'function') return t.toMillis()
  if (typeof t.seconds === 'number') return t.seconds * 1000 + Math.floor((t.nanoseconds ?? 0) / 1e6)
  if (typeof t === 'number') return t
  return null
}

export const isApprovedBaseline = (h) => h?.status === BASELINE_STATUS.APPROVED && tsMillis(h.approvedAt) !== null

// Approved versions, oldest first. Ties on approvedAt (two approvals in the
// same instant) break on the document id so the order is deterministic and
// the same in every browser.
export function compareApproved(a, b) {
  const am = tsMillis(a?.approvedAt) ?? 0
  const bm = tsMillis(b?.approvedAt) ?? 0
  if (am !== bm) return am - bm
  return String(a?.id ?? '').localeCompare(String(b?.id ?? ''))
}

export function approvedBaselines(headers) {
  return (headers ?? []).filter(isApprovedBaseline).sort(compareApproved)
}

// ACTIVE = the most recently approved. ORIGINAL = the earliest approved. A
// draft is never active; a withdrawn draft is never anything.
export function activeBaseline(headers) {
  const list = approvedBaselines(headers)
  return list.length > 0 ? list[list.length - 1] : null
}

export function originalBaseline(headers) {
  const list = approvedBaselines(headers)
  return list.length > 0 ? list[0] : null
}

const cmpCreated = (a, b) => (tsMillis(a?.createdAt) ?? 0) - (tsMillis(b?.createdAt) ?? 0) || String(a?.id ?? '').localeCompare(String(b?.id ?? ''))

export function draftBaselines(headers) {
  return (headers ?? []).filter(h => h?.status === BASELINE_STATUS.DRAFT).sort(cmpCreated)
}

// 1-based position among the approved versions (stable: the approved set is
// append-only), or null for anything not approved.
export function baselineOrdinal(headers, id) {
  const idx = approvedBaselines(headers).findIndex(h => h.id === id)
  return idx === -1 ? null : idx + 1
}

export const BASELINE_DESIGNATION = {
  ACTIVE:          'active',
  ORIGINAL:        'original',
  ACTIVE_ORIGINAL: 'active_original',   // the only approved version so far
  HISTORICAL:      'historical',
}

export const BASELINE_DESIGNATION_LABELS = {
  [BASELINE_DESIGNATION.ACTIVE]:          'Active',
  [BASELINE_DESIGNATION.ORIGINAL]:        'Original',
  [BASELINE_DESIGNATION.ACTIVE_ORIGINAL]: 'Active · Original',
  [BASELINE_DESIGNATION.HISTORICAL]:      'Historical',
}

export function baselineDesignation(headers, id) {
  const active = activeBaseline(headers)
  const original = originalBaseline(headers)
  if (!active || !id) return null
  if (active.id === id && original?.id === id) return BASELINE_DESIGNATION.ACTIVE_ORIGINAL
  if (active.id === id) return BASELINE_DESIGNATION.ACTIVE
  if (original?.id === id) return BASELINE_DESIGNATION.ORIGINAL
  return baselineOrdinal(headers, id) === null ? null : BASELINE_DESIGNATION.HISTORICAL
}

// "Baseline 2 — Revised programme after CV-0004"
export function baselineVersionLabel(headers, header) {
  if (!header) return ''
  const n = baselineOrdinal(headers, header.id)
  const name = String(header.name ?? '').trim()
  if (n === null) return name || 'Draft baseline'
  return name ? `Baseline ${n} — ${name}` : `Baseline ${n}`
}

// The selector: every approved version, newest first, with its designation.
export function baselineSelectorOptions(headers) {
  return approvedBaselines(headers).slice().reverse().map(h => ({
    id: h.id,
    label: baselineVersionLabel(headers, h),
    designation: baselineDesignation(headers, h.id),
    designationLabel: BASELINE_DESIGNATION_LABELS[baselineDesignation(headers, h.id)] ?? '',
    approvedAt: h.approvedAt,
  }))
}

// Resolves a selection ('active' or an approved id) to the header, or null.
export const ACTIVE_CHOICE = 'active'

export function selectedBaseline(headers, choice) {
  if (!choice || choice === ACTIVE_CHOICE) return activeBaseline(headers)
  const h = (headers ?? []).find(x => x?.id === choice) ?? null
  return isApprovedBaseline(h) ? h : null
}

// ── The snapshot as read ─────────────────────────────────────────────────────

// Entries by activity id. A malformed snapshot (not a list, entries without
// an id) yields what can be read — the variance layer treats a missing entry
// as "added after", never as a satisfied comparison.
export function snapshotEntryIndex(snapshot) {
  const m = new Map()
  const list = Array.isArray(snapshot?.activities) ? snapshot.activities : []
  for (const e of list) {
    const id = e !== null && typeof e === 'object' && typeof e.activityId === 'string' ? e.activityId : ''
    if (id && !m.has(id)) m.set(id, e)
  }
  return m
}

// True when the snapshot document is usable at all.
export const isSnapshotUsable = (snapshot) =>
  Boolean(snapshot) && Array.isArray(snapshot.activities) && Number.isInteger(snapshot.activityCount)

// ── Drift: the live programme versus a captured snapshot ─────────────────────
//
// What changed since the capture — shown to the approver, who must review it
// explicitly. Read-time only; the approve action re-reads the server and
// refuses when the drift it finds is not the drift the approver acknowledged.

export function programmeDrift(activities, snapshot) {
  const byEntry = snapshotEntryIndex(snapshot)
  const live = new Map()
  for (const a of activities ?? []) if (a?.id) live.set(a.id, a)

  const changed = []
  const added = []
  const cancelledAfter = []
  const missing = []

  for (const a of live.values()) {
    const e = byEntry.get(a.id)
    if (!e) { added.push({ activityId: a.id, name: a.name ?? '' }); continue }
    const wasCancelled = e.status === ACTIVITY_STATUS.CANCELLED
    const isCancelled = a.status === ACTIVITY_STATUS.CANCELLED
    if (!wasCancelled && isCancelled) {
      cancelledAfter.push({ activityId: a.id, name: a.name ?? '', from: e.revision, to: activityRevision(a) })
    } else if (activityRevision(a) !== e.revision) {
      changed.push({ activityId: a.id, name: a.name ?? '', from: e.revision, to: activityRevision(a) })
    }
  }
  for (const e of byEntry.values()) {
    if (!live.has(e.activityId)) missing.push({ activityId: e.activityId, name: e.name ?? '' })
  }

  const byName = (x, y) => String(x.name).localeCompare(String(y.name)) || x.activityId.localeCompare(y.activityId)
  for (const l of [changed, added, cancelledAfter, missing]) l.sort(byName)

  const total = changed.length + added.length + cancelledAfter.length + missing.length
  return {
    changed, added, cancelledAfter, missing, total, any: total > 0,
    key: driftKey({ changed, added, cancelledAfter, missing }),
  }
}

// A stable key for the approver's acknowledgement: it names every drifted
// record and revision, so the acknowledgement is of THIS drift and no other.
export function driftKey({ changed = [], added = [], cancelledAfter = [], missing = [] } = {}) {
  const part = (tag, list, withRev) => list
    .map(x => `${x.activityId}${withRev ? `@${x.to}` : ''}`)
    .sort()
    .map(s => `${tag}:${s}`)
  return [
    ...part('c', changed, true), ...part('a', added, false),
    ...part('x', cancelledAfter, true), ...part('m', missing, false),
  ].join('|')
}

// ── Variance ─────────────────────────────────────────────────────────────────

export const VARIANCE_KIND = {
  NO_BASELINE:          'no_baseline',          // no snapshot selected / loaded
  IN_BASELINE:          'in_baseline',          // compared
  ADDED_AFTER:          'added_after',          // live activity absent from the snapshot
  CANCELLED_AT_CAPTURE: 'cancelled_at_capture', // already cancelled history when approved
  CANCELLED_AFTER:      'cancelled_after',      // in the approved plan, cancelled since
  MISSING_SOURCE:       'missing_source',       // snapshot entry whose activity is not loaded
  INVALID:              'invalid',              // unusable date on either side
}

export const VARIANCE_STATE = {
  EARLIER:   'earlier',
  UNCHANGED: 'unchanged',
  LATER:     'later',
}

export const EMPTY_VARIANCE = Object.freeze({
  kind: VARIANCE_KIND.NO_BASELINE, entry: null,
  startVariance: null, finishVariance: null, completionVariance: null,
  startMoved: false, finishMoved: false, moved: false, state: null, completedLate: null,
})

// One activity against one snapshot entry (null entry = added after).
//
//   startVariance      = current planned start  − baseline start
//   finishVariance     = current planned finish − baseline finish
//   completionVariance = actual finish          − baseline finish  (only when recorded)
//
// Positive = later than the baseline, negative = earlier, zero = unchanged.
// Calendar days through the ADR-29 UTC helpers. An actual finish is NEVER
// inferred from a status.
export function activityBaselineVariance(activity, entry) {
  if (!entry) return { ...EMPTY_VARIANCE, kind: activity ? VARIANCE_KIND.ADDED_AFTER : VARIANCE_KIND.NO_BASELINE }
  if (!activity) return { ...EMPTY_VARIANCE, kind: VARIANCE_KIND.MISSING_SOURCE, entry }
  if (entry.status === ACTIVITY_STATUS.CANCELLED) return { ...EMPTY_VARIANCE, kind: VARIANCE_KIND.CANCELLED_AT_CAPTURE, entry }
  if (activity.status === ACTIVITY_STATUS.CANCELLED) return { ...EMPTY_VARIANCE, kind: VARIANCE_KIND.CANCELLED_AFTER, entry }

  const startVariance  = daysBetween(entry.plannedStart, activity.plannedStart)
  const finishVariance = daysBetween(entry.plannedFinish, activity.plannedFinish)
  if (startVariance === null || finishVariance === null) return { ...EMPTY_VARIANCE, kind: VARIANCE_KIND.INVALID, entry }

  const completionVariance = isValidIsoDate(activity.actualFinish)
    ? daysBetween(entry.plannedFinish, activity.actualFinish)
    : null

  const state = finishVariance < 0 ? VARIANCE_STATE.EARLIER
    : finishVariance > 0 ? VARIANCE_STATE.LATER
      : VARIANCE_STATE.UNCHANGED

  return {
    kind: VARIANCE_KIND.IN_BASELINE,
    entry,
    startVariance,
    finishVariance,
    completionVariance,
    startMoved: startVariance !== 0,
    finishMoved: finishVariance !== 0,
    moved: startVariance !== 0 || finishVariance !== 0,
    state,
    // Only a RECORDED finish can be late against the baseline.
    completedLate: completionVariance === null ? null : completionVariance > 0,
  }
}

// activityId → variance for every live activity AND every snapshot entry
// whose source is not loaded. Null snapshot → every activity NO_BASELINE.
export function baselineComparison(activities, snapshot) {
  const out = new Map()
  const usable = isSnapshotUsable(snapshot)
  const byEntry = usable ? snapshotEntryIndex(snapshot) : new Map()
  const live = new Set()
  for (const a of activities ?? []) {
    if (!a?.id) continue
    live.add(a.id)
    out.set(a.id, usable ? activityBaselineVariance(a, byEntry.get(a.id) ?? null) : { ...EMPTY_VARIANCE })
  }
  if (usable) {
    for (const e of byEntry.values()) {
      if (!live.has(e.activityId)) out.set(e.activityId, activityBaselineVariance(null, e))
    }
  }
  return out
}

export const varianceFor = (comparison, activityId) => comparison?.get(activityId) ?? EMPTY_VARIANCE

// ── Text ─────────────────────────────────────────────────────────────────────

const dayWord = (n) => (Math.abs(n) === 1 ? 'day' : 'days')

// '+6 days' / '−3 days' / 'unchanged'
export function formatDayDelta(n) {
  if (!Number.isFinite(n)) return '—'
  if (n === 0) return 'unchanged'
  return `${n > 0 ? '+' : '−'}${Math.abs(n)} ${dayWord(n)}`
}

// '+6 d' / '−3 d' / '0 d' — the compact column.
export function formatDayDeltaShort(n) {
  if (!Number.isFinite(n)) return '—'
  if (n === 0) return '0 d'
  return `${n > 0 ? '+' : '−'}${Math.abs(n)} d`
}

// The sentence for a bar's accessible name, the detail and the cards.
export function varianceLabel(v, { isMilestone = false } = {}) {
  if (!v) return ''
  switch (v.kind) {
    case VARIANCE_KIND.NO_BASELINE: return ''
    case VARIANCE_KIND.ADDED_AFTER: return 'Added after the baseline was approved'
    case VARIANCE_KIND.CANCELLED_AT_CAPTURE: return 'Already cancelled when the baseline was approved'
    case VARIANCE_KIND.CANCELLED_AFTER: return 'Cancelled since the baseline was approved'
    case VARIANCE_KIND.MISSING_SOURCE: return 'In the baseline but not in the programme'
    case VARIANCE_KIND.INVALID: return 'Cannot be compared — an unusable date'
    default: break
  }
  const milestone = isMilestone || v.entry?.isMilestone === true
  if (milestone) {
    return v.finishVariance === 0
      ? 'Milestone unchanged from baseline'
      : `Milestone planned ${formatDayDelta(v.finishVariance)} ${v.finishVariance > 0 ? 'later' : 'earlier'} than baseline`
  }
  if (!v.moved) return 'Unchanged from baseline'
  const parts = []
  if (v.startMoved) parts.push(`start ${formatDayDelta(v.startVariance)}`)
  if (v.finishMoved) parts.push(`finish ${formatDayDelta(v.finishVariance)}`)
  else parts.push('finish unchanged')
  return `Planned ${parts.join(', ')} against baseline`
}

// 'Finished 3 days after the baseline finish' — only from a RECORDED finish.
export function completionLabel(v, { isMilestone = false } = {}) {
  if (!v || v.kind !== VARIANCE_KIND.IN_BASELINE || v.completionVariance === null) return ''
  const what = isMilestone || v.entry?.isMilestone === true ? 'Reached' : 'Finished'
  const n = v.completionVariance
  if (n === 0) return `${what} on the baseline ${what === 'Reached' ? 'date' : 'finish'}`
  return `${what} ${Math.abs(n)} ${dayWord(n)} ${n > 0 ? 'after' : 'before'} the baseline ${what === 'Reached' ? 'date' : 'finish'}`
}

// The compact column / card value: '+6 d', '0 d', 'Added', 'Cancelled', '—'.
export function varianceShort(v) {
  if (!v) return '—'
  switch (v.kind) {
    case VARIANCE_KIND.IN_BASELINE: return formatDayDeltaShort(v.finishVariance)
    case VARIANCE_KIND.ADDED_AFTER: return 'Added'
    case VARIANCE_KIND.CANCELLED_AFTER:
    case VARIANCE_KIND.CANCELLED_AT_CAPTURE: return 'Cancelled'
    case VARIANCE_KIND.MISSING_SOURCE: return 'Missing'
    case VARIANCE_KIND.INVALID: return 'Invalid'
    default: return '—'
  }
}

// Baseline dates as a sentence: 'Baseline 05/10/2026 to 09/10/2026' /
// 'Baseline milestone 05/10/2026'.
export function baselineDatesLabel(entry) {
  if (!entry) return ''
  if (entry.isMilestone) return `Baseline milestone ${formatIsoDate(entry.plannedStart)}`
  return `Baseline ${formatIsoDate(entry.plannedStart)} to ${formatIsoDate(entry.plannedFinish)}`
}

// ── Summary (defensible counts only) ─────────────────────────────────────────
//
// Counts and one named maximum. Deliberately NO average delay (overlapping
// activities make it meaningless), NO project completion delay and NO
// critical-path conclusion. The programme ENVELOPE is the latest planned
// finish on each side — labelled as such, never as forecast completion.

export function baselineSummary(activities, snapshot) {
  const usable = isSnapshotUsable(snapshot)
  const comparison = baselineComparison(activities, snapshot)
  const s = {
    available: usable,
    captured: usable ? snapshotEntryIndex(snapshot).size : 0,
    cancelledAtCapture: 0,
    addedAfter: 0,
    cancelledSince: 0,
    missingSource: 0,
    invalid: 0,
    compared: 0,
    earlier: 0,
    unchanged: 0,
    later: 0,
    startMovedOnly: 0,
    milestonesCompared: 0,
    milestonesLater: 0,
    completedCompared: 0,
    completedLate: 0,
    largestFinish: null,   // { days, activityId, name } — the single largest finish variance (positive)
    envelope: null,        // { baselineFinish, currentFinish, days }
  }
  if (!usable) return s

  const byId = new Map()
  for (const a of activities ?? []) if (a?.id) byId.set(a.id, a)

  let baselineFinish = null
  let currentFinish = null
  for (const e of snapshotEntryIndex(snapshot).values()) {
    if (e.status !== ACTIVITY_STATUS.CANCELLED && isValidIsoDate(e.plannedFinish)) {
      if (baselineFinish === null || e.plannedFinish > baselineFinish) baselineFinish = e.plannedFinish
    }
  }
  for (const a of byId.values()) {
    if (a.status !== ACTIVITY_STATUS.CANCELLED && isValidIsoDate(a.plannedFinish)) {
      if (currentFinish === null || a.plannedFinish > currentFinish) currentFinish = a.plannedFinish
    }
  }
  if (baselineFinish !== null && currentFinish !== null) {
    s.envelope = { baselineFinish, currentFinish, days: daysBetween(baselineFinish, currentFinish) }
  }

  for (const [id, v] of comparison.entries()) {
    const a = byId.get(id) ?? null
    const milestone = v.entry?.isMilestone === true || a?.isMilestone === true
    switch (v.kind) {
      case VARIANCE_KIND.CANCELLED_AT_CAPTURE: s.cancelledAtCapture += 1; break
      case VARIANCE_KIND.ADDED_AFTER: s.addedAfter += 1; break
      case VARIANCE_KIND.CANCELLED_AFTER: s.cancelledSince += 1; break
      case VARIANCE_KIND.MISSING_SOURCE: s.missingSource += 1; break
      case VARIANCE_KIND.INVALID: s.invalid += 1; break
      case VARIANCE_KIND.IN_BASELINE: {
        s.compared += 1
        if (v.state === VARIANCE_STATE.EARLIER) s.earlier += 1
        else if (v.state === VARIANCE_STATE.LATER) s.later += 1
        else { s.unchanged += 1; if (v.startMoved) s.startMovedOnly += 1 }
        if (milestone) { s.milestonesCompared += 1; if (v.state === VARIANCE_STATE.LATER) s.milestonesLater += 1 }
        if (v.completionVariance !== null) { s.completedCompared += 1; if (v.completedLate) s.completedLate += 1 }
        if (v.finishVariance > 0 && (s.largestFinish === null || v.finishVariance > s.largestFinish.days
            || (v.finishVariance === s.largestFinish.days && id < s.largestFinish.activityId))) {
          s.largestFinish = { days: v.finishVariance, activityId: id, name: a?.name ?? v.entry?.name ?? '' }
        }
        break
      }
      default: break
    }
  }
  return s
}
