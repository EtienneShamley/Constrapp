import { INDICATOR, PULSE_STATE } from './pulse'
import { todayIso, isIsoDateShape } from './payments'
import { isValidIsoDate } from './projectTimeline'

// ── Constrapp PULSE™ 1B — acknowledgement & attention (ADR-49) ───────────────
//
// A PURE layer BESIDE lib/pulse.js, never inside it. PULSE 1A decides whether a
// condition is supported by the records; this module decides whether a
// FINDING currently needs a manager's attention, given the one acknowledgement
// document the project may hold for that indicator
// (…/pulseAcknowledgements/{indicatorId}). It reads the evaluated indicator
// and the acknowledgement, and returns a management state. It changes NO
// indicator state, NO count and NO figure — an acknowledgement is a human
// statement about a finding, not a resolution of it, and never a financial
// approval or audit certification.
//
// Finding identity (ADR-49 Decision 3) has two levels and uses nothing that
// moves between evaluations:
//
//   · the CONDITION is the indicator id — one per project, and the document id
//   · the EVIDENCE is the set of record ids the finding currently rests on —
//     cost-code ids for the two forecast indicators, activity / supplier
//     invoice / variation document ids for the others, and NO keys for the
//     project-level gross-profit condition
//
// Never list position, never render order, never a monetary value, never a
// generated id: a record's amount can change without its id changing, which is
// exactly why an acknowledgement is labelled with its recorded date and a
// REQUIRED review-by date rather than presented as a review of today's values.
//
// There is no history and no background clock: a condition that clears and
// reappears with the SAME record ids between two visits cannot be told apart
// from one that persisted — the review-by date is the bound on that blind spot
// and the only lapse for a keyless finding.

export const ACK_STATUS = {
  ACTIVE:    'active',
  WITHDRAWN: 'withdrawn',
}

// The management state of ONE indicator, derived at read time.
export const ATTENTION = {
  NEEDS_ATTENTION:   'needs_attention',   // a finding with no standing acknowledgement
  ACKNOWLEDGED:      'acknowledged',      // a finding covered by a standing acknowledgement
  NO_LONGER_PRESENT: 'no_longer_present', // no issue now, but an active acknowledgement remains
  NOT_APPLICABLE:    'not_applicable',    // loading / unavailable / needs data / plain no issue
  LOADING:           'loading',           // the acknowledgement read has not settled
  UNKNOWN:           'unknown',           // the acknowledgement read FAILED — never "nobody acknowledged"
}

// Why a finding needs attention.
export const ATTENTION_REASON = {
  NONE:         'no_acknowledgement',
  NEW_EVIDENCE: 'new_evidence',
  REVIEW_DUE:   'review_due',
  WITHDRAWN:    'withdrawn',
}

// Rules-enforced limits (firestore.rules → pulseAcknowledgements).
export const ACK_NOTE_MAX_LENGTH = 500
export const EVIDENCE_KEY_LIMIT  = 200

// Who may acknowledge or withdraw — the programme-writer audience (ADR-29),
// deliberately NOT the qs role. Mirrors the rules block; the UX gate only.
export const PULSE_ACK_WRITE_ROLES = ['company_admin', 'project_manager']
export const canManageAcknowledgements = (role) => PULSE_ACK_WRITE_ROLES.includes(role)

// Pending variation exposure is "exposure, not an error" (ADR-47 Decision 8),
// so its acknowledgement is worded as a review.
export const ACK_WORDING = {
  default: { verb: 'Acknowledge', past: 'Acknowledged', noun: 'acknowledgement', save: 'Save acknowledgement' },
  review:  { verb: 'Mark as reviewed', past: 'Reviewed', noun: 'review', save: 'Save review' },
}
export const ackWording = (indicatorId) =>
  indicatorId === INDICATOR.PENDING_VARIATION_EXPOSURE ? ACK_WORDING.review : ACK_WORDING.default

// ── Evidence keys ────────────────────────────────────────────────────────────

// Which field on an evidence row is the stable record id. The two forecast
// indicators rest on cost codes (the commercial spine — immutable, ADR-39);
// the gross-profit condition is project-level and has no rows.
const EVIDENCE_ID_FIELD = {
  [INDICATOR.FORECAST_OVER_BUDGET]:       'costCodeId',
  [INDICATOR.FORECAST_INCOMPLETE]:        'costCodeId',
  [INDICATOR.NEGATIVE_GROSS_PROFIT]:      null,
  [INDICATOR.OVERDUE_ACTIVITIES]:         'id',
  [INDICATOR.PAST_DUE_SUPPLIER_INVOICES]: 'id',
  [INDICATOR.PENDING_VARIATION_EXPOSURE]: 'id',
}

// Tolerates a malformed stored value (non-list, non-string elements): rules
// require a list, but the page must never throw on what it reads.
export const normaliseEvidenceKeys = (keys) =>
  [...new Set((Array.isArray(keys) ? keys : []).filter(k => typeof k === 'string' && k.length > 0))].sort()

// The sorted, de-duplicated record ids a FINDING currently rests on. For any
// other state the set is empty — there is nothing to acknowledge.
//
// Over budget also carries the unbudgeted cost codes listed beside the
// over-budget rows (`values.unbudgetedRows`): a negative total variance can
// come from unbudgeted cost alone, so those codes are part of the finding.
export function evidenceKeysFor(indicator) {
  if (!indicator || indicator.state !== PULSE_STATE.FINDING) return []
  const field = EVIDENCE_ID_FIELD[indicator.id]
  if (!field) return []
  const rows = [...(indicator.evidence ?? [])]
  if (indicator.id === INDICATOR.FORECAST_OVER_BUDGET) rows.push(...(indicator.values?.unbudgetedRows ?? []))
  return normaliseEvidenceKeys(rows.map(r => r?.[field]))
}

// Set difference on two already-normalised key lists.
const keysNotIn = (keys, other) => {
  const set = new Set(other ?? [])
  return (keys ?? []).filter(k => !set.has(k))
}

// ── Dates ────────────────────────────────────────────────────────────────────

// The viewer's local calendar day as 'YYYY-MM-DD' — the Timeline convention.
export const localDayIso = (now = new Date()) => todayIso(now)

// A Firestore Timestamp (or a plain {seconds} shape) → the viewer's local
// calendar day as ISO, or null while a server timestamp is still pending.
export function timestampToIso(ts) {
  if (!ts) return null
  if (typeof ts.toDate === 'function') return todayIso(ts.toDate())
  if (typeof ts.seconds === 'number') return todayIso(new Date(ts.seconds * 1000))
  return null
}

// The review date has ARRIVED or PASSED — string comparison is exact for
// zero-padded ISO, and an unparseable stored date counts as due (never as an
// open-ended acknowledgement).
export const isReviewDue = (reviewBy, today) =>
  !isValidIsoDate(reviewBy) || !isValidIsoDate(today) || reviewBy <= today

// ── Attention ────────────────────────────────────────────────────────────────

// `indicator`: one lib/pulse.js indicator. `ack`: the project's acknowledgement
// document for that indicator id, or null. `ackState`: the acknowledgement
// subscription's { loading, error } — kept SEPARATE from the indicator's own
// sources, so a failed acknowledgement read never touches the indicator and the
// indicator's state never depends on it. `now`: the viewer's local day.
export function attentionFor({ indicator, ack = null, ackState = {}, now = new Date() } = {}) {
  const base = {
    indicatorId: indicator?.id ?? null,
    state: ATTENTION.NOT_APPLICABLE,
    reason: null,
    ack: null,
    currentKeys: [],
    newKeys: [],
    clearedKeys: [],
    reviewDue: false,
  }
  if (!indicator) return base
  if (ackState.loading) return { ...base, state: ATTENTION.LOADING }
  if (ackState.error)   return { ...base, state: ATTENTION.UNKNOWN }

  const active = ack?.status === ACK_STATUS.ACTIVE ? ack : null

  if (indicator.state === PULSE_STATE.NO_ISSUE) {
    return active ? { ...base, state: ATTENTION.NO_LONGER_PRESENT, ack: active } : base
  }
  if (indicator.state !== PULSE_STATE.FINDING) return base

  const currentKeys = evidenceKeysFor(indicator)
  if (!ack) return { ...base, state: ATTENTION.NEEDS_ATTENTION, reason: ATTENTION_REASON.NONE, currentKeys }
  if (!active) return { ...base, state: ATTENTION.NEEDS_ATTENTION, reason: ATTENTION_REASON.WITHDRAWN, ack, currentKeys }

  const ackKeys = normaliseEvidenceKeys(active.evidenceKeys)
  const newKeys = keysNotIn(currentKeys, ackKeys)
  const clearedKeys = keysNotIn(ackKeys, currentKeys)
  const reviewDue = isReviewDue(active.reviewBy, localDayIso(now))
  const detail = { ack: active, currentKeys, newKeys, clearedKeys, reviewDue }

  if (newKeys.length > 0) return { ...base, ...detail, state: ATTENTION.NEEDS_ATTENTION, reason: ATTENTION_REASON.NEW_EVIDENCE }
  if (reviewDue)          return { ...base, ...detail, state: ATTENTION.NEEDS_ATTENTION, reason: ATTENTION_REASON.REVIEW_DUE }
  return { ...base, ...detail, state: ATTENTION.ACKNOWLEDGED }
}

// Indicators that are findings, split by attention, in the order given.
export function splitFindings(indicators, attentionById) {
  const out = { needsAttention: [], acknowledged: [], unknown: [] }
  for (const ind of indicators ?? []) {
    if (!ind || ind.state !== PULSE_STATE.FINDING) continue
    const a = attentionById?.[ind.id]?.state
    if (a === ATTENTION.ACKNOWLEDGED) out.acknowledged.push(ind)
    else if (a === ATTENTION.NEEDS_ATTENTION) out.needsAttention.push(ind)
    else out.unknown.push(ind)
  }
  return out
}

// ── Input validation (the client mirror of the rules block) ──────────────────

// Whether a finding CAN be acknowledged right now. More than EVIDENCE_KEY_LIMIT
// records cannot be referenced by one document; the set is never truncated and
// no partial acknowledgement is saved (ADR-49 Decision 6).
export function acknowledgementAvailability(indicator) {
  if (!indicator || indicator.state !== PULSE_STATE.FINDING) {
    return { ok: false, reason: 'not_a_finding', keyCount: 0 }
  }
  const keyCount = evidenceKeysFor(indicator).length
  if (keyCount > EVIDENCE_KEY_LIMIT) return { ok: false, reason: 'too_many_evidence', keyCount }
  return { ok: true, reason: null, keyCount }
}

// Returns an error message, or null when the input is acceptable. The review
// date must be AFTER today: a review due today would need attention at once.
export function validateAcknowledgementInput({ note, reviewBy } = {}, now = new Date()) {
  const trimmed = typeof note === 'string' ? note.trim() : ''
  if (trimmed.length === 0) return 'A note is required — say what is being done about this finding.'
  if (trimmed.length > ACK_NOTE_MAX_LENGTH) return `The note must be ${ACK_NOTE_MAX_LENGTH} characters or fewer.`
  if (!isIsoDateShape(reviewBy) || !isValidIsoDate(reviewBy)) return 'A review-by date is required (YYYY-MM-DD).'
  if (reviewBy <= localDayIso(now)) return 'The review-by date must be after today.'
  return null
}

export const normaliseAcknowledgementInput = ({ note, reviewBy } = {}) => ({
  note: String(note ?? '').trim(),
  reviewBy,
})

// ── Outcomes of the guarded writes ───────────────────────────────────────────

export const ACK_ERROR = {
  INVALID:    'invalid',
  STALE:      'stale',
  MISSING:    'missing',
  PERMISSION: 'permission',
  OFFLINE:    'offline',
  UNKNOWN:    'unknown',
}

export const ACK_ERROR_MESSAGES = {
  [ACK_ERROR.INVALID]:    'This acknowledgement is no longer valid for the finding. Nothing was saved.',
  [ACK_ERROR.STALE]:      'Someone else changed this acknowledgement after it was loaded. Nothing was saved — review the latest version and try again.',
  [ACK_ERROR.MISSING]:    'There is no acknowledgement to withdraw. Nothing was changed.',
  [ACK_ERROR.PERMISSION]: 'You do not have permission to acknowledge PULSE findings. Nothing was saved.',
  [ACK_ERROR.OFFLINE]:    'You appear to be offline. Nothing was saved — reconnect and try again.',
  [ACK_ERROR.UNKNOWN]:    'The acknowledgement could not be saved. Nothing was changed.',
}

// Maps a Firestore error code to an outcome. The writes run in a transaction,
// which needs the server: offline they FAIL rather than queue, so an
// acknowledgement can never land later against a version nobody saw.
export function acknowledgementErrorKind(code) {
  if (code === 'permission-denied' || code === 'unauthenticated') return ACK_ERROR.PERMISSION
  if (code === 'unavailable' || code === 'deadline-exceeded') return ACK_ERROR.OFFLINE
  if (code === 'aborted' || code === 'failed-precondition') return ACK_ERROR.STALE
  if (code === 'not-found') return ACK_ERROR.MISSING
  return ACK_ERROR.UNKNOWN
}

// The version comparison the guarded writes make: the document the user SAW
// versus the server copy read inside the transaction. `revision` increments on
// every write (rules-enforced +1), so a mismatch means someone wrote in between.
export function sameAcknowledgementVersion(seen, current) {
  if (!seen || !current) return false
  return Number.isInteger(seen.revision) && seen.revision === current.revision
}
