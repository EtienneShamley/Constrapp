import { todayIso } from './payments'
import { isValidIsoDate, daysBetween, formatIsoDate } from './projectTimeline'

// ── RFIs — Requests for Information (pure domain logic, ADR-33) ──────────────
//
// An RFI is the formal record of a question that needed clarification during
// the project: who asked what, of whom, against which drawing revision or
// document, when it was due, what the answer was, and when it arrived.
//
// THE COMMERCIAL FRAME. RFI V1 is an EVIDENCE LAYER for future delay / EOT /
// variation / forecast analysis. It stores the record and STABLE COMMERCIAL
// JOIN KEYS ONLY (an optional cost code, a drawing-revision or document
// reference). It implements NO financial derivation and changes NO financial
// figure — no budget, commitment, actual, forecast, margin, cash-flow or
// variation effect of any kind. Cost impact, time impact and variation
// origination are explicitly deferred.
//
// Everything in this file is PURE: no Firestore, no React, no clock. Anything
// date-relative takes an injected `now` (defaulting to `new Date()`) exactly as
// lib/projectTimeline.js and lib/cashFlow.js do, so the unit suite can pin the
// calendar.
//
// ⚠️ THIS MODULE PERFORMS NO FINANCIAL ARITHMETIC AND READS NO FINANCIAL
// DOCUMENT. There is no amount, no currency and no GST anywhere in an RFI, and
// creating one must NEVER engage the project currency ratchet (ADR-21).

// ── Status ───────────────────────────────────────────────────────────────────
//
// Five states, FORWARD-ONLY (the ADR-11 default — an RFI is a contractual audit
// record, not a plan, so unlike the programme it is never corrected backwards):
//
//   draft ──raise──► open ──answer──► answered ──close──► closed
//     │                │
//     └──cancel──►  cancelled  ◄──cancel──┘
//
// · `closed` and `cancelled` are TERMINAL — no update of any kind afterwards.
// · There is NO REOPEN. An unsatisfactory answer is closed with an explanatory
//   close-out note and a NEW RFI is raised. Answer history, threads and
//   supersession links are deliberately absent.
// · `answered` CANNOT be cancelled: once an answer is on the record the only
//   exit is to close it (with a note saying why, if the answer was no good).
//   Cancelling exists for mistaken or duplicate questions, and a question that
//   has been answered was not a mistake to ask.
// · Hard delete is prohibited at every status (ADR-12).
export const RFI_STATUS = {
  DRAFT:     'draft',
  OPEN:      'open',
  ANSWERED:  'answered',
  CLOSED:    'closed',
  CANCELLED: 'cancelled',
}

export const RFI_STATUS_ORDER = [
  RFI_STATUS.DRAFT,
  RFI_STATUS.OPEN,
  RFI_STATUS.ANSWERED,
  RFI_STATUS.CLOSED,
  RFI_STATUS.CANCELLED,
]

export const RFI_STATUS_LABELS = {
  [RFI_STATUS.DRAFT]:     'Draft',
  [RFI_STATUS.OPEN]:      'Open',
  [RFI_STATUS.ANSWERED]:  'Answered',
  [RFI_STATUS.CLOSED]:    'Closed',
  [RFI_STATUS.CANCELLED]: 'Cancelled',
}

// Badge variants from the existing design system — NEVER a new colour value.
// Status is also always rendered as TEXT, so nothing is communicated by colour
// alone.
export const RFI_STATUS_BADGE = {
  [RFI_STATUS.DRAFT]:     'soon',
  [RFI_STATUS.OPEN]:      'info',
  [RFI_STATUS.ANSWERED]:  'pending',
  [RFI_STATUS.CLOSED]:    'active',
  [RFI_STATUS.CANCELLED]: 'danger',
}

// The complete transition whitelist. Anything not listed is illegal — including
// answered → cancelled, every backwards move, and every exit from a terminal
// state. Mirrored exactly by the `rfis` block of firestore.rules.
export const RFI_TRANSITIONS = {
  [RFI_STATUS.DRAFT]:     [RFI_STATUS.OPEN, RFI_STATUS.CANCELLED],
  [RFI_STATUS.OPEN]:      [RFI_STATUS.ANSWERED, RFI_STATUS.CANCELLED],
  [RFI_STATUS.ANSWERED]:  [RFI_STATUS.CLOSED],
  [RFI_STATUS.CLOSED]:    [],
  [RFI_STATUS.CANCELLED]: [],
}

export const TERMINAL_STATUSES = [RFI_STATUS.CLOSED, RFI_STATUS.CANCELLED]

export const isRfiStatus = (s) => RFI_STATUS_ORDER.includes(s)

export const isTerminalStatus = (s) => TERMINAL_STATUSES.includes(s)

// Still on the register as unfinished business — not closed, not cancelled.
export const isActiveStatus = (s) => isRfiStatus(s) && !isTerminalStatus(s)

// Awaiting an answer. The ONLY status that can be overdue: a draft has not
// been asked yet, and an answered RFI has its answer.
export const isAwaitingAnswer = (s) => s === RFI_STATUS.OPEN

export function canTransition(from, to) {
  if (!isRfiStatus(from) || !isRfiStatus(to)) return false
  return RFI_TRANSITIONS[from].includes(to)
}

// ── Editability by status ────────────────────────────────────────────────────
//
// THE QUESTION BLOCK (title, question, raised date, reference, cost code)
// freezes the moment the RFI is RAISED — that freeze is the entire reason
// `draft` exists. THE MANAGEMENT BLOCK (assignee, due date) stays editable one
// state longer, because reassignment and a due-date extension are legitimate
// on a live RFI; it freezes once an answer exists, because after that the
// dates ARE the record.
export const canEditQuestion   = (s) => s === RFI_STATUS.DRAFT
export const canEditManagement = (s) => s === RFI_STATUS.DRAFT || s === RFI_STATUS.OPEN
export const canRaise          = (s) => canTransition(s, RFI_STATUS.OPEN)
export const canAnswer         = (s) => canTransition(s, RFI_STATUS.ANSWERED)
export const canClose          = (s) => canTransition(s, RFI_STATUS.CLOSED)
export const canCancel         = (s) => canTransition(s, RFI_STATUS.CANCELLED)

// ── Roles ────────────────────────────────────────────────────────────────────
//
// ⚠️ THESE ARE UX HELPERS, NOT AUTHORISATION. Firestore Security Rules are the
// only trust boundary (docs/ENGINEERING_STANDARDS.md §7). The `rfis` rules
// block is what actually enforces the matrix.
//
// Read and write coincide: the three internal roles. QS is a full author here
// (unlike the programme) because measurement and scope ambiguity is the
// classic RFI trigger and QS already writes general documents.
//
// `subcontractor` and `client` are absent deliberately: RFI content routinely
// carries contractual positions, and those roles are not scoped to their own
// projects (docs/SECURITY.md → Deferred Control 20). `super_admin` gains
// nothing, matching every other collection.
export const RFI_ROLES = ['company_admin', 'project_manager', 'qs']

export const canReadRfis  = (role) => RFI_ROLES.includes(role)
export const canWriteRfis = (role) => RFI_ROLES.includes(role)

// ── Numbering ────────────────────────────────────────────────────────────────
//
// PER-PROJECT sequence: companies/{c}/projects/{p}/counters/rfis → { next }.
// Every project starts at RFI-0001, independently — the construction
// convention. Allocated inside the SAME transaction as the RFI write
// (hooks/useRfis.jsx). This is the first PROJECT-scoped counter in Constrapp;
// every financial counter is company-wide.
//
// ⚠️ Uniqueness is NOT rules-enforced. Rules have no list, query or count, and
// the counter is client-writable with no +1-only constraint (Deferred Control
// 6). Normal app creates are transaction-safe; a direct-SDK caller can
// duplicate a number or reset the counter.
export const RFI_COUNTER_ID = 'rfis'

export const formatRfiNumber = (n) => `RFI-${String(n).padStart(4, '0')}`

const RFI_NUMBER_PARTS = /^RFI-(\d+)$/

// The integer inside an RFI number, or null when it does not parse.
export function parseRfiNumber(rfiNumber) {
  if (typeof rfiNumber !== 'string') return null
  const m = RFI_NUMBER_PARTS.exec(rfiNumber)
  return m ? Number(m[1]) : null
}

// ── Reference ────────────────────────────────────────────────────────────────
//
// ZERO OR ONE reference, as SCALAR fields — never an array. Rules cannot
// iterate an array or get() per element, so a scalar target is the only shape
// whose existence can be verified at the boundary (the credit-note lesson).
//
// A DRAWING reference names BOTH the master AND a specific revision — the RFI
// stays linked to exactly the sheet as issued when the question was asked, and
// never floats to "whatever is current later". A master-only reference is not
// supported. Labels are FROZEN display snapshots so a register row renders
// without reading the drawings collection; a later rename never rewrites them.
//
// Never copied: no bytes, no storagePath, no download URL.
export const REFERENCE_TYPE = {
  NONE:     'none',
  DRAWING:  'drawing',
  DOCUMENT: 'document',
}

export const REFERENCE_TYPES = Object.values(REFERENCE_TYPE)

export const REFERENCE_TYPE_LABELS = {
  [REFERENCE_TYPE.NONE]:     'No reference',
  [REFERENCE_TYPE.DRAWING]:  'Drawing revision',
  [REFERENCE_TYPE.DOCUMENT]: 'General document',
}

export const isReferenceType = (t) => REFERENCE_TYPES.includes(t)

export const hasReference = (rfi) =>
  rfi?.referenceType === REFERENCE_TYPE.DRAWING || rfi?.referenceType === REFERENCE_TYPE.DOCUMENT

// 'A-101 Ground Floor Plan · Rev C' / 'Structural Spec' / ''
export function referenceLabel(rfi) {
  if (!hasReference(rfi)) return ''
  const label = String(rfi.referenceLabel ?? '')
  if (rfi.referenceType === REFERENCE_TYPE.DRAWING && rfi.referenceRevisionCode) {
    return `${label} · Rev ${rfi.referenceRevisionCode}`
  }
  return label
}

// ── Dates (never stored derivations) ─────────────────────────────────────────
//
// RFI dates are date-only 'YYYY-MM-DD' STRINGS, as every human-entered date in
// the app. `raisedDate` and `answerDate` are AUTHORED — the real-world dates on
// the correspondence — and are kept separate from `raisedAt` / `answeredAt`,
// which are the system transition stamps. Response time is measured between
// the authored dates, because the transcription date is not the answer date.
//
// ⚠️ Compared in the VIEWER'S LOCAL TIMEZONE via todayIso(now), with no
// normalisation — the same documented limitation as lib/payments.js.

// Overdue = open, with a real due date that has passed. Never a draft (not yet
// asked), never answered/closed/cancelled (no answer is outstanding). Due TODAY
// is not overdue.
export function isOverdue(rfi, now = new Date()) {
  if (!rfi || !isAwaitingAnswer(rfi.status)) return false
  if (!isValidIsoDate(rfi.dueDate)) return false
  return rfi.dueDate < todayIso(now)
}

// Days past due (positive), or null when not overdue.
export function daysLate(rfi, now = new Date()) {
  if (!isOverdue(rfi, now)) return null
  return daysBetween(rfi.dueDate, todayIso(now))
}

// Days until due for an OPEN RFI: 0 = due today, negative = past. null when
// the RFI is not awaiting an answer or has no usable due date.
export function daysUntilDue(rfi, now = new Date()) {
  if (!rfi || !isAwaitingAnswer(rfi.status)) return null
  if (!isValidIsoDate(rfi.dueDate)) return null
  return daysBetween(todayIso(now), rfi.dueDate)
}

// Days the question has been (or was) outstanding, from the authored raised
// date: to today while open, to the authored answer date once answered/closed.
// null for a draft (not yet asked) or a cancelled RFI.
export function daysOpen(rfi, now = new Date()) {
  if (!rfi || !isValidIsoDate(rfi.raisedDate)) return null
  if (rfi.status === RFI_STATUS.OPEN) return daysBetween(rfi.raisedDate, todayIso(now))
  if (rfi.status === RFI_STATUS.ANSWERED || rfi.status === RFI_STATUS.CLOSED) {
    return responseDays(rfi)
  }
  return null
}

// The commercial metric: authored answer date − authored raised date. null
// until an answer exists.
export function responseDays(rfi) {
  if (!rfi) return null
  if (rfi.status !== RFI_STATUS.ANSWERED && rfi.status !== RFI_STATUS.CLOSED) return null
  if (!isValidIsoDate(rfi.raisedDate) || !isValidIsoDate(rfi.answerDate)) return null
  return daysBetween(rfi.raisedDate, rfi.answerDate)
}

// ── Grouping (drives the mobile card list) ───────────────────────────────────
export const RFI_GROUP = {
  OVERDUE:        'overdue',
  DUE_SOON:       'due_soon',
  OPEN:           'open',
  AWAITING_CLOSE: 'awaiting_close',
  DRAFT:          'draft',
  CLOSED:         'closed',
}

export const RFI_GROUP_ORDER = [
  RFI_GROUP.OVERDUE,
  RFI_GROUP.DUE_SOON,
  RFI_GROUP.OPEN,
  RFI_GROUP.AWAITING_CLOSE,
  RFI_GROUP.DRAFT,
  RFI_GROUP.CLOSED,
]

export const RFI_GROUP_LABELS = {
  [RFI_GROUP.OVERDUE]:        'Overdue',
  [RFI_GROUP.DUE_SOON]:       'Due this week',
  [RFI_GROUP.OPEN]:           'Open',
  [RFI_GROUP.AWAITING_CLOSE]: 'Awaiting close',
  [RFI_GROUP.DRAFT]:          'Draft',
  [RFI_GROUP.CLOSED]:         'Closed / Cancelled',
}

export const RFI_GROUP_HINTS = {
  [RFI_GROUP.OVERDUE]:        'Due date has passed and no answer is recorded',
  [RFI_GROUP.DUE_SOON]:       'Answer due within the next 7 days',
  [RFI_GROUP.OPEN]:           'Raised and awaiting an answer',
  [RFI_GROUP.AWAITING_CLOSE]: 'Answered — review the answer and close',
  [RFI_GROUP.DRAFT]:          'Not yet raised',
  [RFI_GROUP.CLOSED]:         'No longer outstanding',
}

export const DUE_SOON_DAYS = 7

export function rfiGroup(rfi, now = new Date()) {
  if (!rfi) return RFI_GROUP.OPEN
  if (isTerminalStatus(rfi.status)) return RFI_GROUP.CLOSED
  if (rfi.status === RFI_STATUS.DRAFT) return RFI_GROUP.DRAFT
  if (rfi.status === RFI_STATUS.ANSWERED) return RFI_GROUP.AWAITING_CLOSE
  if (isOverdue(rfi, now)) return RFI_GROUP.OVERDUE
  const until = daysUntilDue(rfi, now)
  if (until !== null && until <= DUE_SOON_DAYS) return RFI_GROUP.DUE_SOON
  return RFI_GROUP.OPEN
}

// Every group key is always present (possibly empty) so the caller renders a
// stable set of sections. RFIs inside each group are deterministically sorted.
export function groupRfis(rfis, now = new Date()) {
  const out = {}
  for (const key of RFI_GROUP_ORDER) out[key] = []
  for (const r of rfis ?? []) out[rfiGroup(r, now)].push(r)
  for (const key of RFI_GROUP_ORDER) out[key] = sortRfis(out[key])
  return out
}

// ── Summary (the four cards) ─────────────────────────────────────────────────
export function rfiSummary(rfis, now = new Date()) {
  const list = rfis ?? []
  let draft = 0
  let open = 0
  let overdue = 0
  let awaitingClose = 0
  let closed = 0
  let cancelled = 0

  for (const r of list) {
    if (r.status === RFI_STATUS.DRAFT)     draft += 1
    if (r.status === RFI_STATUS.OPEN)      open += 1
    if (r.status === RFI_STATUS.ANSWERED)  awaitingClose += 1
    if (r.status === RFI_STATUS.CLOSED)    closed += 1
    if (r.status === RFI_STATUS.CANCELLED) cancelled += 1
    if (isOverdue(r, now)) overdue += 1
  }

  return { total: list.length, draft, open, overdue, awaitingClose, closed, cancelled }
}

// ── Deterministic ordering ───────────────────────────────────────────────────
//
// Newest number first — the register reads like a log. A number that does not
// parse (only possible via a direct-SDK write) sorts LAST rather than
// disappearing; ties break on title, then document id, so rows never flicker.
export function compareRfis(a, b) {
  const an = parseRfiNumber(a?.rfiNumber)
  const bn = parseRfiNumber(b?.rfiNumber)
  if (an !== bn) {
    if (an === null) return 1
    if (bn === null) return -1
    return bn - an
  }
  const at = (a?.title ?? '').toLowerCase()
  const bt = (b?.title ?? '').toLowerCase()
  if (at !== bt) return at < bt ? -1 : 1
  return String(a?.id ?? '').localeCompare(String(b?.id ?? ''))
}

// Returns a NEW array — never sorts the caller's list in place.
export function sortRfis(rfis) {
  return [...(rfis ?? [])].sort(compareRfis)
}

// ── Filtering ────────────────────────────────────────────────────────────────
//
// Four controls, all client-side over the loaded snapshot. Deliberately NOT a
// filter builder (docs/PRODUCT.md → "What Constrapp Is Not").
export function filterRfis(rfis, filters = {}, now = new Date()) {
  const {
    search = '',
    status = '',
    assignedToContactId = '',
    overdueOnly = false,
  } = filters
  const needle = search.trim().toLowerCase()

  return (rfis ?? []).filter((r) => {
    if (status && r.status !== status) return false
    if (assignedToContactId && (r.assignedToContactId ?? '') !== assignedToContactId) return false
    if (overdueOnly && !isOverdue(r, now)) return false
    if (needle) {
      const haystack = [r.rfiNumber, r.title, r.question]
        .map(v => (v ?? '').toLowerCase())
        .join(' ')
      if (!haystack.includes(needle)) return false
    }
    return true
  })
}

// The assignees present on the register, for the filter picker.
export function assigneeOptions(rfis) {
  const seen = new Map()
  for (const r of rfis ?? []) {
    const id = r?.assignedToContactId
    if (!id) continue
    if (!seen.has(id)) seen.set(id, r.assignedToName || id)
  }
  return [...seen.entries()]
    .map(([id, name]) => ({ id, name }))
    .sort((x, y) => x.name.localeCompare(y.name))
}

// ── Draft normalisation & validation ─────────────────────────────────────────
//
// `normaliseRfiDraft` produces EXACTLY the authored field set (minus number,
// status and stamps), so the hook, the modal and the validator all agree on one
// shape and the client can never assemble a document the rules block would
// reject for a reason the user never sees.

const trimTo = (v, max) => String(v ?? '').trim().slice(0, max)

export const LIMITS = {
  title: 200,
  question: 5000,
  raisedByName: 120,
  assignedToName: 120,
  costCodeName: 120,
  referenceLabel: 200,
  referenceRevisionCode: 40,
  answer: 5000,
  closeOutNote: 1000,
  cancelReason: 500,
}

const isoOrNull = (v) => (isValidIsoDate(v) ? v : null)

const strOrNull = (v) => (v ? String(v) : null)

// The question block + the management block, normalised.
export function normaliseRfiDraft(draft = {}) {
  const hasContact  = Boolean(draft.assignedToContactId)
  const hasCostCode = Boolean(draft.costCodeId)
  const type = isReferenceType(draft.referenceType) ? draft.referenceType : REFERENCE_TYPE.NONE
  const isDrawing  = type === REFERENCE_TYPE.DRAWING
  const isDocument = type === REFERENCE_TYPE.DOCUMENT

  return {
    title:      trimTo(draft.title, LIMITS.title),
    question:   trimTo(draft.question, LIMITS.question),
    raisedDate: typeof draft.raisedDate === 'string' ? draft.raisedDate.trim() : '',

    referenceType:         type,
    referenceDrawingId:    isDrawing  ? strOrNull(draft.referenceDrawingId)  : null,
    referenceRevisionId:   isDrawing  ? strOrNull(draft.referenceRevisionId) : null,
    referenceDocumentId:   isDocument ? strOrNull(draft.referenceDocumentId) : null,
    referenceLabel:        (isDrawing || isDocument) ? trimTo(draft.referenceLabel, LIMITS.referenceLabel) : '',
    referenceRevisionCode: isDrawing  ? trimTo(draft.referenceRevisionCode, LIMITS.referenceRevisionCode) : '',

    costCodeId:   hasCostCode ? String(draft.costCodeId) : null,
    costCodeName: hasCostCode ? trimTo(draft.costCodeName, LIMITS.costCodeName) : '',

    assignedToContactId: hasContact ? String(draft.assignedToContactId) : null,
    assignedToName:      hasContact ? trimTo(draft.assignedToName, LIMITS.assignedToName) : '',
    dueDate:             isoOrNull(typeof draft.dueDate === 'string' ? draft.dueDate.trim() : draft.dueDate),
  }
}

// Validates the reference fields of a NORMALISED draft. Returns a message or
// null. Every check has a rules counterpart; the rules additionally verify the
// referenced documents EXIST, which this cannot.
export function validateReference(d) {
  if (!isReferenceType(d.referenceType)) return 'Choose a reference type'
  if (d.referenceType === REFERENCE_TYPE.NONE) {
    if (d.referenceDrawingId || d.referenceRevisionId || d.referenceDocumentId) {
      return 'Clear the reference or choose a reference type'
    }
    if (d.referenceLabel || d.referenceRevisionCode) return 'Clear the reference or choose a reference type'
    return null
  }
  if (d.referenceType === REFERENCE_TYPE.DRAWING) {
    if (!d.referenceDrawingId) return 'Choose a drawing'
    if (!d.referenceRevisionId) return 'Choose the specific drawing revision this RFI refers to'
    if (d.referenceDocumentId) return 'An RFI references a drawing revision or a document, not both'
    if (!d.referenceLabel) return 'Choose a drawing'
    if (!d.referenceRevisionCode) return 'Choose the specific drawing revision this RFI refers to'
    return null
  }
  // document
  if (!d.referenceDocumentId) return 'Choose a document'
  if (d.referenceDrawingId || d.referenceRevisionId) {
    return 'An RFI references a drawing revision or a document, not both'
  }
  if (d.referenceRevisionCode) return 'A document reference has no revision code'
  if (!d.referenceLabel) return 'Choose a document'
  return null
}

// Both-or-neither on the assignee pair.
export function validateAssignment(d) {
  if (d.assignedToContactId && !d.assignedToName) return 'Choose an assignee'
  if (!d.assignedToContactId && d.assignedToName) return 'Choose an assignee'
  return null
}

// Both-or-neither on the cost-code pair.
export function validateCostCodePair(d) {
  if (d.costCodeId && !d.costCodeName) return 'Choose a cost code'
  if (!d.costCodeId && d.costCodeName) return 'Choose a cost code'
  return null
}

// Due date is optional on a draft, but when present it must be a real date on
// or after the raised date.
export function validateDueDate(draftDueDate, normalisedDueDate, raisedDate) {
  if (draftDueDate && !normalisedDueDate) return 'Due date is not a valid date'
  if (normalisedDueDate && isValidIsoDate(raisedDate) && normalisedDueDate < raisedDate) {
    return 'Due date cannot be before the raised date'
  }
  return null
}

// The DRAFT shape — everything a draft may hold. Returns an error MESSAGE or
// null. Assignee and due date are OPTIONAL here; `validateRaise` demands them.
export function validateRfiDraft(draft) {
  const d = normaliseRfiDraft(draft)

  if (!d.title) return 'Enter a title'
  if (String(draft?.title ?? '').trim().length > LIMITS.title) {
    return `The title must be ${LIMITS.title} characters or fewer`
  }
  if (!d.question) return 'Enter the question'
  if (String(draft?.question ?? '').trim().length > LIMITS.question) {
    return `The question must be ${LIMITS.question} characters or fewer`
  }
  if (!isValidIsoDate(d.raisedDate)) return 'Enter the date the RFI was raised'

  const refError = validateReference(d)
  if (refError) return refError

  const ccError = validateCostCodePair(d)
  if (ccError) return ccError

  const asgError = validateAssignment(d)
  if (asgError) return asgError

  return validateDueDate(draft?.dueDate, d.dueDate, d.raisedDate)
}

// The MANAGEMENT edit — assignee + due date. The raised date is read from the
// stored document because the question block is frozen.
//
// On an OPEN RFI the assignee and due date may be CHANGED but never CLEARED:
// they are the accountability fields of a live RFI, and the raise gate is a
// standing invariant of the open state (mirrored by rules branch (c)).
export function validateManagementDraft(draft, rfi) {
  const d = normaliseRfiDraft({ ...draft, raisedDate: rfi?.raisedDate })
  const asgError = validateAssignment(d)
  if (asgError) return asgError
  const dueError = validateDueDate(draft?.dueDate, d.dueDate, rfi?.raisedDate)
  if (dueError) return dueError
  if (rfi?.status === RFI_STATUS.OPEN) {
    if (!d.assignedToContactId) return 'An open RFI must stay assigned — reassign it instead'
    if (!d.dueDate) return 'An open RFI must keep a due date — change it instead'
  }
  return null
}

// Raise gate: a valid draft that ALSO has an assignee and a due date.
export function validateRaise(rfi) {
  if (!rfi) return 'RFI not found'
  if (!canRaise(rfi.status)) return 'Only a draft RFI can be raised'
  const draftError = validateRfiDraft(rfi)
  if (draftError) return draftError
  if (!rfi.assignedToContactId) return 'Assign the RFI to a contact before raising it'
  if (!isValidIsoDate(rfi.dueDate)) return 'Set a due date before raising the RFI'
  return null
}

// Answer gate.
export function validateAnswer({ answer, answerDate } = {}, rfi) {
  if (!rfi) return 'RFI not found'
  if (!canAnswer(rfi.status)) return 'Only an open RFI can be answered'
  const a = String(answer ?? '').trim()
  if (!a) return 'Enter the answer'
  if (a.length > LIMITS.answer) return `The answer must be ${LIMITS.answer} characters or fewer`
  if (!isValidIsoDate(answerDate)) return 'Enter the date the answer was received'
  if (isValidIsoDate(rfi.raisedDate) && answerDate < rfi.raisedDate) {
    return 'The answer date cannot be before the raised date'
  }
  return null
}

// Close gate. The note is optional.
export function validateClose(closeOutNote, rfi) {
  if (!rfi) return 'RFI not found'
  if (!canClose(rfi.status)) return 'Only an answered RFI can be closed'
  const n = String(closeOutNote ?? '').trim()
  if (n.length > LIMITS.closeOutNote) {
    return `The close-out note must be ${LIMITS.closeOutNote} characters or fewer`
  }
  return null
}

export function validateCancelReason(reason) {
  const r = String(reason ?? '').trim()
  if (!r) return 'Enter a reason for cancelling this RFI'
  if (r.length > LIMITS.cancelReason) {
    return `The reason must be ${LIMITS.cancelReason} characters or fewer`
  }
  return null
}

// Cancel gate — status AND reason.
export function validateCancel(reason, rfi) {
  if (!rfi) return 'RFI not found'
  if (rfi.status === RFI_STATUS.ANSWERED) {
    return 'An answered RFI cannot be cancelled — close it with a note instead'
  }
  if (!canCancel(rfi.status)) return 'This RFI can no longer be cancelled'
  return validateCancelReason(reason)
}

// ── Presentation helpers ─────────────────────────────────────────────────────

export { formatIsoDate }

// The plain-language due/late line. Text, never colour alone.
export function dueLabel(rfi, now = new Date()) {
  if (!rfi) return ''
  if (rfi.status === RFI_STATUS.CANCELLED) return 'Cancelled'
  if (rfi.status === RFI_STATUS.CLOSED) return 'Closed'
  if (rfi.status === RFI_STATUS.ANSWERED) {
    const days = responseDays(rfi)
    if (days === null) return 'Answered'
    return days === 1 ? 'Answered in 1 day' : `Answered in ${days} days`
  }
  if (rfi.status === RFI_STATUS.DRAFT) return 'Draft — not yet raised'
  const late = daysLate(rfi, now)
  if (late !== null) return late === 1 ? '1 day overdue' : `${late} days overdue`
  const until = daysUntilDue(rfi, now)
  if (until === null) return 'No due date'
  if (until === 0) return 'Due today'
  if (until === 1) return 'Due tomorrow'
  return `Due in ${until} days`
}
