// ── Drawings (master + immutable revisions) ──────────────────────────────────
//
// A DRAWING MASTER is the stable identity of a sheet ("A-101 Ground Floor
// Plan"). A REVISION is one issue of that sheet, with its own file. Revisions
// are IMMUTABLE: once created, a revision is never deleted, never repointed at
// different bytes, and never edited beyond its lifecycle stamps.
//
// The master carries a POINTER to the authored current revision
// (`currentRevisionId`) plus mirrored display fields, so a register row renders
// without reading the revisions subcollection.
//
// ⚠️ FUTURE QUANT IDENTITY. Takeoff will reference { drawingId, revisionId,
// page } — never drawingNumber, never master.currentRevisionId, never the
// filename. `drawingId` and `revisionId` are random Firestore IDs and are the
// only stable identity in this module. A drawing number can be corrected; the
// current-revision pointer moves by design; filenames are user text.
//
// ⚠️ ORDER REVISIONS BY `revisionSequence`, NEVER BY `revisionCode`. Codes are
// free text from the real world ("A", "B", "P1", "C2", "1", "10") and sort
// wrongly under every lexical comparison. `revisionSequence` is the integer the
// promotion transaction assigns.

export const REVISION_SCHEMA_VERSION = 1

// Roles permitted to create drawings, issue revisions, and withdraw.
//
// ⚠️ UX MIRROR ONLY — Firestore and Storage Rules are the enforced boundary.
// QS is deliberately ABSENT: a QS measures from drawings but does not control
// which revision the site builds from. QS retains general-document write.
export const DRAWING_WRITE_ROLES = ['company_admin', 'project_manager']
export const canWriteDrawings = (role) => DRAWING_WRITE_ROLES.includes(role)

// Drawing READS are open to every provisioned member of the company — including
// subcontractor and client — because a drawing is operational site information
// and withholding the current sheet is the actual safety risk.
//
// ⚠️ KNOWN LIMITATION: membership is COMPANY-WIDE, not project-specific, so a
// member of the company can read the drawings of every project in that company.
// Per-project membership is deferred (docs/SECURITY.md → Deferred Control 20).

export const DRAWING_STATUS = {
  ACTIVE:    'active',
  WITHDRAWN: 'withdrawn',
}

export const REVISION_STATUS = {
  CURRENT:    'current',
  SUPERSEDED: 'superseded',
  WITHDRAWN:  'withdrawn',
}

export const DISCIPLINES = [
  'architectural',
  'structural',
  'civil',
  'mechanical',
  'electrical',
  'hydraulic',
  'landscape',
  'other',
]

const DISCIPLINE_LABELS = {
  architectural: 'Architectural',
  structural:    'Structural',
  civil:         'Civil',
  mechanical:    'Mechanical',
  electrical:    'Electrical',
  hydraulic:     'Hydraulic',
  landscape:     'Landscape',
  other:         'Other',
}

export const formatDiscipline = (d) => DISCIPLINE_LABELS[d] ?? d ?? '—'

const REVISION_STATUS_LABELS = {
  current:    'Current',
  superseded: 'Superseded',
  withdrawn:  'Withdrawn',
}

export const formatRevisionStatus = (s) => REVISION_STATUS_LABELS[s] ?? s ?? '—'

// ── Lifecycle legality ───────────────────────────────────────────────────────
//
// current    → superseded  (a newer revision was issued)
// current    → withdrawn   (recalled)
// superseded → current     (explicitly reinstated when the current is withdrawn)
// superseded → withdrawn   (recalled)
// withdrawn  → nothing     (terminal — a recalled issue is never un-recalled)
const REVISION_TRANSITIONS = {
  current:    ['superseded', 'withdrawn'],
  superseded: ['current', 'withdrawn'],
  withdrawn:  [],
}

export const canTransitionRevision = (from, to) =>
  (REVISION_TRANSITIONS[from] ?? []).includes(to)

// active → withdrawn only. Withdrawing a MASTER is terminal in this branch:
// there is no reactivation path, so a recalled drawing cannot quietly return.
const DRAWING_TRANSITIONS = {
  active:    ['withdrawn'],
  withdrawn: [],
}

export const canTransitionDrawing = (from, to) =>
  (DRAWING_TRANSITIONS[from] ?? []).includes(to)

export const isCurrentRevision    = (r) => r?.status === REVISION_STATUS.CURRENT
export const isSupersededRevision = (r) => r?.status === REVISION_STATUS.SUPERSEDED
export const isWithdrawnRevision  = (r) => r?.status === REVISION_STATUS.WITHDRAWN
export const isWithdrawnDrawing   = (d) => d?.status === DRAWING_STATUS.WITHDRAWN

// ── Identity ─────────────────────────────────────────────────────────────────

// Drawing numbers are compared and stored in one canonical form: trimmed,
// internal whitespace collapsed, upper-cased. "a-101 " and "A-101" are the same
// sheet, and a register that shows both is a register nobody trusts.
export function normaliseDrawingNumber(value) {
  return String(value ?? '').trim().replace(/\s+/g, ' ').toUpperCase()
}

// The existing drawing that already uses this number, or null.
//
// ⚠️ WARNING-ONLY, AND CLIENT-SIDE ONLY. Firestore rules cannot query siblings,
// so uniqueness CANNOT be enforced (docs/SECURITY.md). Two users creating
// "A-101" simultaneously both succeed. The UI warns; it never blocks, because a
// legitimate re-numbering must stay possible.
export function findDuplicateDrawingNumber(drawings, drawingNumber, excludeId = null) {
  const target = normaliseDrawingNumber(drawingNumber)
  if (!target) return null
  return (drawings ?? []).find(d =>
    d.id !== excludeId && normaliseDrawingNumber(d.drawingNumber) === target
  ) ?? null
}

// Same warning-only treatment for revision codes WITHIN one drawing: issuing
// "B" twice is almost always a mistake, but the register must not become
// un-editable because of it.
export function findDuplicateRevisionCode(revisions, revisionCode) {
  const target = normaliseRevisionCode(revisionCode)
  if (!target) return null
  return (revisions ?? []).find(r => normaliseRevisionCode(r.revisionCode) === target) ?? null
}

export const normaliseRevisionCode = (value) =>
  String(value ?? '').trim().replace(/\s+/g, '').toUpperCase()

// ── Ordering ─────────────────────────────────────────────────────────────────

// Newest issue first. Sorted on the INTEGER sequence — never on revisionCode.
export function sortRevisions(revisions) {
  return [...(revisions ?? [])].sort(
    (a, b) => (b?.revisionSequence ?? 0) - (a?.revisionSequence ?? 0)
  )
}

// The sequence the NEXT revision receives. Derived from the master's
// revisionCount, which the promotion transaction increments by exactly 1 — so
// sequences are dense and monotonic even after withdrawals.
export const nextRevisionSequence = (drawing) =>
  Number(drawing?.revisionCount ?? 0) + 1

// The revision the master currently points at, resolved from a loaded list.
// Falls back to the status field when the pointer is missing (a master whose
// first upload failed has revisionCount 0 and currentRevisionId null).
export function currentRevision(drawing, revisions) {
  const list = revisions ?? []
  if (drawing?.currentRevisionId) {
    return list.find(r => r.id === drawing.currentRevisionId) ?? null
  }
  return list.find(isCurrentRevision) ?? null
}

// Revisions the user may nominate to REINSTATE when withdrawing the current
// one. Withdrawn revisions can never come back, and the revision being
// withdrawn is obviously not a candidate.
export function reinstatableRevisions(revisions, withdrawingRevisionId) {
  return sortRevisions(revisions).filter(r =>
    r.id !== withdrawingRevisionId && !isWithdrawnRevision(r)
  )
}

// ── Validation ───────────────────────────────────────────────────────────────

// 'YYYY-MM-DD' shape, matching how every other calendar date in the app is
// stored. Defined locally so this module stays independent of the financial
// libraries.
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
export const isIsoDateShape = (v) => typeof v === 'string' && ISO_DATE.test(v)

// Returns an error string, or null when the drawing identity is acceptable.
export function validateDrawingDraft({ drawingNumber, title, discipline }) {
  if (!normaliseDrawingNumber(drawingNumber)) return 'Enter a drawing number'
  if (!String(title ?? '').trim())            return 'Enter a drawing title'
  if (!DISCIPLINES.includes(discipline))      return 'Choose a discipline'
  return null
}

// Returns an error string, or null when the revision identity is acceptable.
// The FILE is validated separately by lib/files.js.
export function validateRevisionDraft({ revisionCode, revisionDate }) {
  if (!normaliseRevisionCode(revisionCode)) return 'Enter a revision code'
  if (normaliseRevisionCode(revisionCode).length > 12) {
    return 'Revision code is too long (max 12 characters)'
  }
  if (!isIsoDateShape(revisionDate)) return 'Enter the revision date'
  return null
}

// A withdrawal always requires a real reason — a register that records "why"
// as an empty string records nothing. Enforced here AND by Firestore rules.
export function validateWithdrawReason(reason) {
  return String(reason ?? '').trim() ? null : 'Enter a reason for withdrawing'
}

// Shown when the drawing's current revision moved while this user was
// uploading. The promotion is ABORTED rather than retried: automatically
// promoting these bytes would silently overwrite whatever the other user just
// issued, and the two revisions are not interchangeable.
export const CONCURRENT_REVISION_MESSAGE =
  'Another user issued a revision while you were uploading. Review the drawing before re-issuing.'

// ── Register filtering ───────────────────────────────────────────────────────

// Search matches drawing number, title, discipline label, and current revision
// code. `discipline` narrows to one discipline. `includeWithdrawn` is false by
// default: the SAFE default view is what the site may actually build from.
export function filterDrawings(drawings, { search = '', discipline = '', includeWithdrawn = false } = {}) {
  const term = String(search ?? '').trim().toLowerCase()
  return (drawings ?? []).filter(d => {
    if (!includeWithdrawn && isWithdrawnDrawing(d)) return false
    if (discipline && d.discipline !== discipline) return false
    if (!term) return true
    const haystack = [
      d.drawingNumber,
      d.title,
      formatDiscipline(d.discipline),
      d.currentRevisionCode,
    ].map(v => String(v ?? '').toLowerCase())
    return haystack.some(v => v.includes(term))
  })
}

// ── Safety messaging ─────────────────────────────────────────────────────────
//
// Opening anything other than the current revision must SAY SO IN WORDS.
// Returns { tone, title, body } or null. `tone` drives styling; it never
// carries the meaning on its own — status is always spelled out in the title,
// so the warning survives greyscale printing and colour-blind readers.
export function revisionWarning(revision, drawing) {
  if (!revision) return null

  if (isWithdrawnRevision(revision)) {
    return {
      tone:  'withdrawn',
      title: 'WITHDRAWN',
      body:  'Do not use this drawing.',
    }
  }

  if (isSupersededRevision(revision)) {
    const currentCode = drawing?.currentRevisionCode
    return {
      tone:  'superseded',
      title: `SUPERSEDED — Revision ${revision.revisionCode}`,
      body:  currentCode
        ? `Do not build from this drawing. Current revision is ${currentCode}.`
        : 'Do not build from this drawing. This drawing has no current revision.',
    }
  }

  // A current revision on a WITHDRAWN master is still not to be built from.
  if (isWithdrawnDrawing(drawing)) {
    return {
      tone:  'withdrawn',
      title: 'WITHDRAWN',
      body:  'This drawing has been withdrawn. Do not use it.',
    }
  }

  return null
}
