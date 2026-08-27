import { describe, it, expect } from 'vitest'
import {
  RFI_STATUS, RFI_STATUS_ORDER, RFI_STATUS_LABELS, RFI_STATUS_BADGE,
  RFI_TRANSITIONS, TERMINAL_STATUSES,
  isRfiStatus, isTerminalStatus, isActiveStatus, isAwaitingAnswer, canTransition,
  canEditQuestion, canEditManagement, canRaise, canAnswer, canClose, canCancel,
  RFI_ROLES, canReadRfis, canWriteRfis,
  RFI_COUNTER_ID, formatRfiNumber, parseRfiNumber,
  REFERENCE_TYPE, REFERENCE_TYPES, isReferenceType, hasReference, referenceLabel,
  isOverdue, daysLate, daysUntilDue, daysOpen, responseDays,
  RFI_GROUP, RFI_GROUP_ORDER, RFI_GROUP_LABELS, DUE_SOON_DAYS, rfiGroup, groupRfis,
  rfiSummary,
  compareRfis, sortRfis,
  filterRfis, assigneeOptions,
  LIMITS, normaliseRfiDraft, validateRfiDraft, validateReference, validateAssignment,
  validateCostCodePair, validateDueDate, validateManagementDraft, validateRaise,
  validateAnswer, validateClose, validateCancelReason, validateCancel,
  formatIsoDate, dueLabel,
} from '../../src/lib/rfis'

// ── RFIs — pure domain unit tests (ADR-33) ───────────────────────────────────
//
// No emulator, no jsdom, no React. Every date-relative assertion pins the clock
// with an injected `now`, so these tests do not rot as the calendar moves.
//
// NOW is constructed with the LOCAL Date constructor because todayIso() reads
// local calendar parts — this keeps the suite timezone-independent.
const NOW = new Date(2026, 9, 15) // 2026-10-15 local, in every timezone
const TODAY = '2026-10-15'

// A valid RFI as the hook stores it (authored + lifecycle fields).
const rfi = (overrides = {}) => ({
  id: 'r1',
  rfiNumber: 'RFI-0001',
  status: RFI_STATUS.DRAFT,
  title: 'Slab thickness at grid C',
  question: 'Drawing shows 200 but spec says 225. Which governs?',
  raisedDate: '2026-10-10',
  raisedByName: 'Sam Site',
  referenceType: REFERENCE_TYPE.NONE,
  referenceDrawingId: null,
  referenceRevisionId: null,
  referenceDocumentId: null,
  referenceLabel: '',
  referenceRevisionCode: '',
  costCodeId: null,
  costCodeName: '',
  assignedToContactId: null,
  assignedToName: '',
  dueDate: null,
  raisedAt: null, raisedBy: null,
  answer: '', answerDate: null, answeredAt: null, answeredBy: null,
  closeOutNote: '', closedAt: null, closedBy: null,
  cancelReason: '', cancelledAt: null, cancelledBy: null,
  ...overrides,
})

const openRfi = (overrides = {}) => rfi({
  status: RFI_STATUS.OPEN,
  assignedToContactId: 'c1', assignedToName: 'Arch Co',
  dueDate: '2026-10-20',
  ...overrides,
})

const drawingRef = {
  referenceType: REFERENCE_TYPE.DRAWING,
  referenceDrawingId: 'd1', referenceRevisionId: 'rev1',
  referenceDocumentId: null,
  referenceLabel: 'A-101 Ground Floor Plan', referenceRevisionCode: 'C',
}
const documentRef = {
  referenceType: REFERENCE_TYPE.DOCUMENT,
  referenceDrawingId: null, referenceRevisionId: null,
  referenceDocumentId: 'doc1',
  referenceLabel: 'Structural Specification', referenceRevisionCode: '',
}

const deepFreeze = (o) => {
  if (o && typeof o === 'object') {
    Object.freeze(o)
    for (const v of Object.values(o)) deepFreeze(v)
  }
  return o
}

// ── Status values ────────────────────────────────────────────────────────────

describe('status values', () => {
  it('exposes exactly the five approved statuses, labelled and badged', () => {
    expect(RFI_STATUS_ORDER).toHaveLength(5)
    expect(new Set(RFI_STATUS_ORDER)).toEqual(new Set(['draft', 'open', 'answered', 'closed', 'cancelled']))
    for (const s of RFI_STATUS_ORDER) {
      expect(typeof RFI_STATUS_LABELS[s]).toBe('string')
      expect(typeof RFI_STATUS_BADGE[s]).toBe('string')
      expect(isRfiStatus(s)).toBe(true)
    }
  })

  it('rejects unknown statuses', () => {
    for (const s of ['DRAFT', 'reopened', 'void', '', null, undefined, 3]) {
      expect(isRfiStatus(s)).toBe(false)
    }
  })

  it('closed and cancelled are terminal; draft/open/answered are active', () => {
    expect(TERMINAL_STATUSES).toEqual(['closed', 'cancelled'])
    expect(isTerminalStatus('closed')).toBe(true)
    expect(isTerminalStatus('cancelled')).toBe(true)
    for (const s of ['draft', 'open', 'answered']) {
      expect(isTerminalStatus(s)).toBe(false)
      expect(isActiveStatus(s)).toBe(true)
    }
    expect(isActiveStatus('closed')).toBe(false)
    expect(isActiveStatus('bogus')).toBe(false)
  })

  it('only open is awaiting an answer', () => {
    expect(isAwaitingAnswer('open')).toBe(true)
    for (const s of ['draft', 'answered', 'closed', 'cancelled']) expect(isAwaitingAnswer(s)).toBe(false)
  })
})

// ── Transitions ──────────────────────────────────────────────────────────────

describe('transition map', () => {
  const LEGAL = [
    ['draft', 'open'], ['draft', 'cancelled'],
    ['open', 'answered'], ['open', 'cancelled'],
    ['answered', 'closed'],
  ]

  it('allows exactly the five legal transitions', () => {
    for (const [from, to] of LEGAL) expect(canTransition(from, to)).toBe(true)
    const listed = Object.entries(RFI_TRANSITIONS).flatMap(([f, tos]) => tos.map(t => [f, t]))
    expect(listed).toHaveLength(5)
  })

  it('rejects every other pair, including self-transitions', () => {
    for (const from of RFI_STATUS_ORDER) {
      for (const to of RFI_STATUS_ORDER) {
        const legal = LEGAL.some(([f, t]) => f === from && t === to)
        expect(canTransition(from, to)).toBe(legal)
      }
    }
  })

  it('answered CANNOT be cancelled', () => {
    expect(canTransition('answered', 'cancelled')).toBe(false)
    expect(canCancel('answered')).toBe(false)
  })

  it('there is no reopen and no backwards move', () => {
    expect(canTransition('answered', 'open')).toBe(false)
    expect(canTransition('open', 'draft')).toBe(false)
    expect(canTransition('closed', 'answered')).toBe(false)
    expect(canTransition('closed', 'open')).toBe(false)
  })

  it('closed and cancelled are terminal', () => {
    for (const to of RFI_STATUS_ORDER) {
      expect(canTransition('closed', to)).toBe(false)
      expect(canTransition('cancelled', to)).toBe(false)
    }
  })

  it('draft cannot skip to answered or closed; open cannot skip to closed', () => {
    expect(canTransition('draft', 'answered')).toBe(false)
    expect(canTransition('draft', 'closed')).toBe(false)
    expect(canTransition('open', 'closed')).toBe(false)
  })

  it('rejects unknown statuses on either side', () => {
    expect(canTransition('bogus', 'open')).toBe(false)
    expect(canTransition('draft', 'bogus')).toBe(false)
    expect(canTransition(undefined, 'open')).toBe(false)
    expect(canTransition('draft', null)).toBe(false)
  })
})

// ── Editability ──────────────────────────────────────────────────────────────

describe('editability by status', () => {
  it('question block is editable in draft only', () => {
    expect(canEditQuestion('draft')).toBe(true)
    for (const s of ['open', 'answered', 'closed', 'cancelled', 'bogus']) expect(canEditQuestion(s)).toBe(false)
  })

  it('management block is editable in draft and open only', () => {
    expect(canEditManagement('draft')).toBe(true)
    expect(canEditManagement('open')).toBe(true)
    for (const s of ['answered', 'closed', 'cancelled', 'bogus']) expect(canEditManagement(s)).toBe(false)
  })

  it('raise / answer / close / cancel predicates follow the map', () => {
    expect(canRaise('draft')).toBe(true)
    expect(canRaise('open')).toBe(false)
    expect(canAnswer('open')).toBe(true)
    expect(canAnswer('draft')).toBe(false)
    expect(canAnswer('answered')).toBe(false)
    expect(canClose('answered')).toBe(true)
    expect(canClose('open')).toBe(false)
    expect(canCancel('draft')).toBe(true)
    expect(canCancel('open')).toBe(true)
    expect(canCancel('closed')).toBe(false)
    expect(canCancel('cancelled')).toBe(false)
  })
})

// ── Roles (UX mirror only) ───────────────────────────────────────────────────

describe('roles', () => {
  it('the three internal roles read and write; nothing else does', () => {
    expect(RFI_ROLES).toEqual(['company_admin', 'project_manager', 'qs'])
    for (const r of RFI_ROLES) {
      expect(canReadRfis(r)).toBe(true)
      expect(canWriteRfis(r)).toBe(true)
    }
    for (const r of ['subcontractor', 'client', 'super_admin', '', undefined]) {
      expect(canReadRfis(r)).toBe(false)
      expect(canWriteRfis(r)).toBe(false)
    }
  })
})

// ── Numbering ────────────────────────────────────────────────────────────────

describe('numbering', () => {
  it('uses the per-project counter id', () => {
    expect(RFI_COUNTER_ID).toBe('rfis')
  })

  it('zero-pads to four digits and overflows past 9999 without truncating', () => {
    expect(formatRfiNumber(1)).toBe('RFI-0001')
    expect(formatRfiNumber(9)).toBe('RFI-0009')
    expect(formatRfiNumber(10)).toBe('RFI-0010')
    expect(formatRfiNumber(999)).toBe('RFI-0999')
    expect(formatRfiNumber(1000)).toBe('RFI-1000')
    expect(formatRfiNumber(10000)).toBe('RFI-10000')
  })

  it('parses its own output and rejects anything else', () => {
    expect(parseRfiNumber('RFI-0001')).toBe(1)
    expect(parseRfiNumber('RFI-10000')).toBe(10000)
    expect(parseRfiNumber(formatRfiNumber(42))).toBe(42)
    for (const bad of ['RFI-', 'rfi-0001', 'PO-0001', '', null, 7, 'RFI-00x1']) {
      expect(parseRfiNumber(bad)).toBeNull()
    }
  })
})

// ── Reference shape ──────────────────────────────────────────────────────────

describe('reference type', () => {
  it('exposes exactly none / drawing / document', () => {
    expect(new Set(REFERENCE_TYPES)).toEqual(new Set(['none', 'drawing', 'document']))
    expect(isReferenceType('drawing')).toBe(true)
    expect(isReferenceType('revision')).toBe(false)
  })

  it('hasReference and referenceLabel', () => {
    expect(hasReference(rfi())).toBe(false)
    expect(referenceLabel(rfi())).toBe('')
    expect(hasReference(rfi(drawingRef))).toBe(true)
    expect(referenceLabel(rfi(drawingRef))).toBe('A-101 Ground Floor Plan · Rev C')
    expect(referenceLabel(rfi(documentRef))).toBe('Structural Specification')
  })
})

describe('validateReference', () => {
  const norm = (o) => normaliseRfiDraft(rfi(o))

  it('accepts a none reference with all ids null and labels empty', () => {
    expect(validateReference(norm({}))).toBeNull()
  })

  it('rejects stray ids or labels on a none reference', () => {
    // normalisation blanks them for `none`, so test the validator directly
    expect(validateReference({ ...norm({}), referenceDrawingId: 'd1' })).not.toBeNull()
    expect(validateReference({ ...norm({}), referenceDocumentId: 'doc1' })).not.toBeNull()
    expect(validateReference({ ...norm({}), referenceLabel: 'x' })).not.toBeNull()
    expect(validateReference({ ...norm({}), referenceRevisionCode: 'A' })).not.toBeNull()
  })

  it('accepts a full drawing reference', () => {
    expect(validateReference(norm(drawingRef))).toBeNull()
  })

  it('drawing reference REQUIRES both drawingId and revisionId', () => {
    expect(validateReference(norm({ ...drawingRef, referenceRevisionId: null }))).toMatch(/revision/i)
    expect(validateReference(norm({ ...drawingRef, referenceDrawingId: null }))).toMatch(/drawing/i)
    expect(validateReference(norm({ ...drawingRef, referenceRevisionId: '' }))).toMatch(/revision/i)
  })

  it('drawing reference requires both frozen labels', () => {
    expect(validateReference(norm({ ...drawingRef, referenceLabel: '' }))).not.toBeNull()
    expect(validateReference(norm({ ...drawingRef, referenceRevisionCode: '' }))).not.toBeNull()
  })

  it('drawing reference rejects a stray document id', () => {
    expect(validateReference({ ...norm(drawingRef), referenceDocumentId: 'doc1' })).toMatch(/not both/)
  })

  it('accepts a full document reference', () => {
    expect(validateReference(norm(documentRef))).toBeNull()
  })

  it('document reference requires id + label and rejects drawing ids / revision code', () => {
    expect(validateReference(norm({ ...documentRef, referenceDocumentId: null }))).toMatch(/document/i)
    expect(validateReference(norm({ ...documentRef, referenceLabel: '' }))).toMatch(/document/i)
    expect(validateReference({ ...norm(documentRef), referenceDrawingId: 'd1' })).toMatch(/not both/)
    expect(validateReference({ ...norm(documentRef), referenceRevisionId: 'r1' })).toMatch(/not both/)
    expect(validateReference({ ...norm(documentRef), referenceRevisionCode: 'A' })).toMatch(/revision code/)
  })

  it('rejects an unknown reference type', () => {
    expect(validateReference({ ...norm({}), referenceType: 'photo' })).not.toBeNull()
  })

  it('normalisation drops fields that do not belong to the chosen type', () => {
    const d = norm({ ...drawingRef, referenceDocumentId: 'doc1' })
    expect(d.referenceDocumentId).toBeNull()
    const n = norm({ referenceType: 'none', referenceDrawingId: 'd1', referenceLabel: 'x' })
    expect(n.referenceDrawingId).toBeNull()
    expect(n.referenceLabel).toBe('')
    const doc = norm({ ...documentRef, referenceRevisionCode: 'B' })
    expect(doc.referenceRevisionCode).toBe('')
  })
})

// ── Pair validation ──────────────────────────────────────────────────────────

describe('assignment and cost-code pairs', () => {
  it('assignment is both-or-neither', () => {
    expect(validateAssignment({ assignedToContactId: null, assignedToName: '' })).toBeNull()
    expect(validateAssignment({ assignedToContactId: 'c1', assignedToName: 'Arch' })).toBeNull()
    expect(validateAssignment({ assignedToContactId: 'c1', assignedToName: '' })).not.toBeNull()
    expect(validateAssignment({ assignedToContactId: null, assignedToName: 'Arch' })).not.toBeNull()
  })

  it('cost code is both-or-neither', () => {
    expect(validateCostCodePair({ costCodeId: null, costCodeName: '' })).toBeNull()
    expect(validateCostCodePair({ costCodeId: 'cc1', costCodeName: '03-100 Concrete' })).toBeNull()
    expect(validateCostCodePair({ costCodeId: 'cc1', costCodeName: '' })).not.toBeNull()
    expect(validateCostCodePair({ costCodeId: null, costCodeName: 'x' })).not.toBeNull()
  })

  it('normalisation blanks the name when the id is absent', () => {
    const d = normaliseRfiDraft(rfi({ assignedToContactId: '', assignedToName: 'Ghost', costCodeId: null, costCodeName: 'Ghost' }))
    expect(d.assignedToContactId).toBeNull()
    expect(d.assignedToName).toBe('')
    expect(d.costCodeName).toBe('')
  })
})

// ── Draft validation ─────────────────────────────────────────────────────────

describe('validateRfiDraft', () => {
  it('accepts a minimal valid draft with no assignee and no due date', () => {
    expect(validateRfiDraft(rfi())).toBeNull()
  })

  it('accepts a complete draft', () => {
    expect(validateRfiDraft(rfi({
      ...drawingRef, costCodeId: 'cc1', costCodeName: 'Concrete',
      assignedToContactId: 'c1', assignedToName: 'Arch', dueDate: '2026-10-20',
    }))).toBeNull()
  })

  it('requires a non-whitespace title and question', () => {
    expect(validateRfiDraft(rfi({ title: '' }))).toMatch(/title/i)
    expect(validateRfiDraft(rfi({ title: '   ' }))).toMatch(/title/i)
    expect(validateRfiDraft(rfi({ question: '' }))).toMatch(/question/i)
    expect(validateRfiDraft(rfi({ question: '\n\t ' }))).toMatch(/question/i)
  })

  it('enforces length boundaries on title and question', () => {
    expect(validateRfiDraft(rfi({ title: 'x'.repeat(LIMITS.title) }))).toBeNull()
    expect(validateRfiDraft(rfi({ title: 'x'.repeat(LIMITS.title + 1) }))).toMatch(/200/)
    expect(validateRfiDraft(rfi({ question: 'x'.repeat(LIMITS.question) }))).toBeNull()
    expect(validateRfiDraft(rfi({ question: 'x'.repeat(LIMITS.question + 1) }))).toMatch(/5000/)
  })

  it('requires a real raised date', () => {
    expect(validateRfiDraft(rfi({ raisedDate: '' }))).toMatch(/raised/i)
    expect(validateRfiDraft(rfi({ raisedDate: '2026-02-30' }))).toMatch(/raised/i)
    expect(validateRfiDraft(rfi({ raisedDate: '10/10/2026' }))).toMatch(/raised/i)
  })

  it('dueDate must be >= raisedDate (equality allowed)', () => {
    expect(validateRfiDraft(rfi({ dueDate: '2026-10-09' }))).toMatch(/before the raised/)
    expect(validateRfiDraft(rfi({ dueDate: '2026-10-10' }))).toBeNull()
    expect(validateRfiDraft(rfi({ dueDate: '2026-10-11' }))).toBeNull()
  })

  it('crosses the year boundary correctly', () => {
    expect(validateRfiDraft(rfi({ raisedDate: '2026-12-31', dueDate: '2027-01-01' }))).toBeNull()
    expect(validateRfiDraft(rfi({ raisedDate: '2027-01-01', dueDate: '2026-12-31' }))).not.toBeNull()
  })

  it('rejects a malformed or impossible due date', () => {
    expect(validateRfiDraft(rfi({ dueDate: 'soon' }))).toMatch(/not a valid date/)
    expect(validateRfiDraft(rfi({ dueDate: '2026-13-01' }))).toMatch(/not a valid date/)
  })

  it('surfaces reference, cost-code and assignment errors', () => {
    expect(validateRfiDraft(rfi({ ...drawingRef, referenceRevisionId: null }))).toMatch(/revision/i)
    expect(validateRfiDraft(rfi({ costCodeId: 'cc1', costCodeName: '' }))).toMatch(/cost code/i)
    expect(validateRfiDraft(rfi({ assignedToContactId: 'c1', assignedToName: '' }))).toMatch(/assignee/i)
  })
})

describe('validateDueDate', () => {
  it('optional; invalid shape flagged; ordering enforced', () => {
    expect(validateDueDate('', null, '2026-10-10')).toBeNull()
    expect(validateDueDate('bad', null, '2026-10-10')).not.toBeNull()
    expect(validateDueDate('2026-10-09', '2026-10-09', '2026-10-10')).not.toBeNull()
    expect(validateDueDate('2026-10-10', '2026-10-10', '2026-10-10')).toBeNull()
  })


  // The browser defect: a partially-cleared native date control reports
  // year 0001. It must be REJECTED as an invalid date (never silently nulled
  // and never accepted), while a genuinely cleared field ('' / null) is a
  // valid "no due date" on a draft.
  it('a cleared field is null; a year-0001 native artefact is rejected, not nulled', () => {
    expect(normaliseRfiDraft(rfi({ dueDate: '' })).dueDate).toBeNull()
    expect(normaliseRfiDraft(rfi({ dueDate: null })).dueDate).toBeNull()
    expect(validateRfiDraft(rfi({ dueDate: '' }))).toBeNull()
    expect(validateRfiDraft(rfi({ dueDate: null }))).toBeNull()
    for (const artefact of ['0001-01-01', '0000-01-01', '0001-01-01T00:00']) {
      expect(normaliseRfiDraft(rfi({ dueDate: artefact })).dueDate).toBeNull()
      expect(validateRfiDraft(rfi({ dueDate: artefact }))).toMatch(/not a valid date/)
      expect(validateManagementDraft({ assignedToContactId: 'c1', assignedToName: 'Arch', dueDate: artefact }, openRfi())).not.toBeNull()
    }
  })
})

describe('validateManagementDraft', () => {
  const stored = openRfi({ raisedDate: '2026-10-10' })

  it('validates assignee pair and due date against the STORED raised date', () => {
    expect(validateManagementDraft({ assignedToContactId: 'c2', assignedToName: 'Eng', dueDate: '2026-10-25' }, stored)).toBeNull()
    expect(validateManagementDraft({ assignedToContactId: 'c2', assignedToName: '', dueDate: '2026-10-25' }, stored)).not.toBeNull()
    expect(validateManagementDraft({ assignedToContactId: 'c2', assignedToName: 'Eng', dueDate: '2026-10-01' }, stored)).toMatch(/before the raised/)
  })

  it('OPEN: reassigning Contact A → B and changing the due date are allowed', () => {
    expect(validateManagementDraft({ assignedToContactId: 'c2', assignedToName: 'Eng Co', dueDate: '2026-10-20' }, stored)).toBeNull()
    expect(validateManagementDraft({ assignedToContactId: 'c1', assignedToName: 'Arch Co', dueDate: '2026-11-30' }, stored)).toBeNull()
  })

  it('OPEN: clearing the assignee, the name, or the due date is REJECTED', () => {
    expect(validateManagementDraft({ assignedToContactId: null, assignedToName: '', dueDate: '2026-10-20' }, stored)).toMatch(/stay assigned/)
    expect(validateManagementDraft({ assignedToContactId: '', assignedToName: '', dueDate: '2026-10-20' }, stored)).toMatch(/stay assigned/)
    expect(validateManagementDraft({ assignedToContactId: 'c1', assignedToName: '', dueDate: '2026-10-20' }, stored)).not.toBeNull()
    expect(validateManagementDraft({ assignedToContactId: 'c1', assignedToName: 'Arch Co', dueDate: null }, stored)).toMatch(/keep a due date/)
    expect(validateManagementDraft({ assignedToContactId: 'c1', assignedToName: 'Arch Co', dueDate: '' }, stored)).toMatch(/keep a due date/)
    expect(validateManagementDraft({ assignedToContactId: null, assignedToName: '', dueDate: '' }, stored)).not.toBeNull()
  })

  it('DRAFT: may still exist without an assignee or due date', () => {
    const draft = rfi({ raisedDate: '2026-10-10' })
    expect(validateManagementDraft({ assignedToContactId: null, assignedToName: '', dueDate: '' }, draft)).toBeNull()
    expect(validateManagementDraft({ assignedToContactId: 'c1', assignedToName: 'Arch Co', dueDate: null }, draft)).toBeNull()
  })
})

// ── Raise gate ───────────────────────────────────────────────────────────────

describe('validateRaise', () => {
  it('requires draft status', () => {
    expect(validateRaise(openRfi())).toMatch(/draft/i)
    expect(validateRaise(rfi({ status: 'closed' }))).toMatch(/draft/i)
    expect(validateRaise(null)).not.toBeNull()
  })

  it('requires an assignee and a due date', () => {
    expect(validateRaise(rfi())).toMatch(/assign/i)
    expect(validateRaise(rfi({ assignedToContactId: 'c1', assignedToName: 'Arch' }))).toMatch(/due date/i)
    expect(validateRaise(rfi({ assignedToContactId: 'c1', assignedToName: 'Arch', dueDate: '2026-10-20' }))).toBeNull()
  })

  it('requires the question block to be valid', () => {
    expect(validateRaise(rfi({ title: '', assignedToContactId: 'c1', assignedToName: 'Arch', dueDate: '2026-10-20' }))).toMatch(/title/i)
  })
})

// ── Answer / close / cancel gates ────────────────────────────────────────────

describe('validateAnswer', () => {
  const open = openRfi({ raisedDate: '2026-10-10' })

  it('accepts a real answer on or after the raised date', () => {
    expect(validateAnswer({ answer: '225 governs.', answerDate: '2026-10-10' }, open)).toBeNull()
    expect(validateAnswer({ answer: '225 governs.', answerDate: '2026-10-14' }, open)).toBeNull()
  })

  it('rejects whitespace answers and over-length answers', () => {
    expect(validateAnswer({ answer: '', answerDate: '2026-10-14' }, open)).toMatch(/answer/i)
    expect(validateAnswer({ answer: '   \n', answerDate: '2026-10-14' }, open)).toMatch(/answer/i)
    expect(validateAnswer({ answer: 'x'.repeat(LIMITS.answer + 1), answerDate: '2026-10-14' }, open)).toMatch(/5000/)
    expect(validateAnswer({ answer: 'x'.repeat(LIMITS.answer), answerDate: '2026-10-14' }, open)).toBeNull()
  })

  it('answerDate must be a real date >= raisedDate', () => {
    expect(validateAnswer({ answer: 'ok', answerDate: '2026-10-09' }, open)).toMatch(/before the raised/)
    expect(validateAnswer({ answer: 'ok', answerDate: '' }, open)).toMatch(/date/i)
    expect(validateAnswer({ answer: 'ok', answerDate: '2026-02-30' }, open)).toMatch(/date/i)
  })

  it('only an open RFI can be answered', () => {
    expect(validateAnswer({ answer: 'ok', answerDate: '2026-10-14' }, rfi())).toMatch(/open/i)
    expect(validateAnswer({ answer: 'ok', answerDate: '2026-10-14' }, rfi({ status: 'answered' }))).toMatch(/open/i)
    expect(validateAnswer({ answer: 'ok', answerDate: '2026-10-14' }, null)).not.toBeNull()
  })
})

describe('validateClose', () => {
  it('only answered closes; note optional and bounded', () => {
    const answered = rfi({ status: 'answered' })
    expect(validateClose('', answered)).toBeNull()
    expect(validateClose('Answer accepted', answered)).toBeNull()
    expect(validateClose('x'.repeat(LIMITS.closeOutNote), answered)).toBeNull()
    expect(validateClose('x'.repeat(LIMITS.closeOutNote + 1), answered)).toMatch(/1000/)
    expect(validateClose('', openRfi())).toMatch(/answered/i)
    expect(validateClose('', rfi({ status: 'closed' }))).toMatch(/answered/i)
  })
})

describe('validateCancelReason / validateCancel', () => {
  it('requires a non-whitespace, bounded reason', () => {
    expect(validateCancelReason('Duplicate of RFI-0003')).toBeNull()
    expect(validateCancelReason('')).not.toBeNull()
    expect(validateCancelReason('  \t ')).not.toBeNull()
    expect(validateCancelReason(null)).not.toBeNull()
    expect(validateCancelReason('x'.repeat(LIMITS.cancelReason))).toBeNull()
    expect(validateCancelReason('x'.repeat(LIMITS.cancelReason + 1))).toMatch(/500/)
  })

  it('cancel is allowed from draft and open only', () => {
    expect(validateCancel('dup', rfi())).toBeNull()
    expect(validateCancel('dup', openRfi())).toBeNull()
    expect(validateCancel('dup', rfi({ status: 'answered' }))).toMatch(/close it/i)
    expect(validateCancel('dup', rfi({ status: 'closed' }))).toMatch(/no longer/i)
    expect(validateCancel('dup', rfi({ status: 'cancelled' }))).toMatch(/no longer/i)
    expect(validateCancel('', openRfi())).toMatch(/reason/i)
  })
})

// ── Overdue & day derivations ────────────────────────────────────────────────

describe('isOverdue', () => {
  it('open + due before today = overdue; due today is NOT overdue', () => {
    expect(isOverdue(openRfi({ dueDate: '2026-10-14' }), NOW)).toBe(true)
    expect(isOverdue(openRfi({ dueDate: TODAY }), NOW)).toBe(false)
    expect(isOverdue(openRfi({ dueDate: '2026-10-16' }), NOW)).toBe(false)
  })

  it('never overdue when draft, answered, closed or cancelled — regardless of due date', () => {
    for (const status of ['draft', 'answered', 'closed', 'cancelled']) {
      expect(isOverdue(openRfi({ status, dueDate: '2020-01-01' }), NOW)).toBe(false)
    }
  })

  it('no or invalid due date → not overdue', () => {
    expect(isOverdue(openRfi({ dueDate: null }), NOW)).toBe(false)
    expect(isOverdue(openRfi({ dueDate: '2026-02-30' }), NOW)).toBe(false)
    expect(isOverdue(null, NOW)).toBe(false)
  })
})

describe('daysLate / daysUntilDue', () => {
  it('daysLate counts days past due, null when not overdue', () => {
    expect(daysLate(openRfi({ dueDate: '2026-10-14' }), NOW)).toBe(1)
    expect(daysLate(openRfi({ dueDate: '2026-10-05' }), NOW)).toBe(10)
    expect(daysLate(openRfi({ dueDate: TODAY }), NOW)).toBeNull()
    expect(daysLate(openRfi({ status: 'answered', dueDate: '2026-10-05' }), NOW)).toBeNull()
  })

  it('daysUntilDue: 0 today, positive future, negative past, null when not open', () => {
    expect(daysUntilDue(openRfi({ dueDate: TODAY }), NOW)).toBe(0)
    expect(daysUntilDue(openRfi({ dueDate: '2026-10-22' }), NOW)).toBe(7)
    expect(daysUntilDue(openRfi({ dueDate: '2026-10-12' }), NOW)).toBe(-3)
    expect(daysUntilDue(openRfi({ dueDate: null }), NOW)).toBeNull()
    expect(daysUntilDue(rfi({ dueDate: '2026-10-22' }), NOW)).toBeNull()
    expect(daysUntilDue(openRfi({ status: 'answered', dueDate: '2026-10-22' }), NOW)).toBeNull()
  })
})

describe('responseDays / daysOpen', () => {
  it('responseDays = answerDate − raisedDate once answered or closed', () => {
    expect(responseDays(rfi({ status: 'answered', raisedDate: '2026-10-10', answerDate: '2026-10-14' }))).toBe(4)
    expect(responseDays(rfi({ status: 'closed', raisedDate: '2026-10-10', answerDate: '2026-10-10' }))).toBe(0)
    expect(responseDays(rfi({ status: 'answered', raisedDate: '2026-12-30', answerDate: '2027-01-02' }))).toBe(3)
  })

  it('responseDays is null while open/draft/cancelled or when a date is unusable', () => {
    expect(responseDays(openRfi())).toBeNull()
    expect(responseDays(rfi())).toBeNull()
    expect(responseDays(rfi({ status: 'cancelled', answerDate: '2026-10-14' }))).toBeNull()
    expect(responseDays(rfi({ status: 'answered', answerDate: null }))).toBeNull()
    expect(responseDays(null)).toBeNull()
  })

  it('daysOpen runs to today while open, to the answer date afterwards, null otherwise', () => {
    expect(daysOpen(openRfi({ raisedDate: '2026-10-10' }), NOW)).toBe(5)
    expect(daysOpen(rfi({ status: 'answered', raisedDate: '2026-10-10', answerDate: '2026-10-12' }), NOW)).toBe(2)
    expect(daysOpen(rfi({ status: 'closed', raisedDate: '2026-10-10', answerDate: '2026-10-12' }), NOW)).toBe(2)
    expect(daysOpen(rfi(), NOW)).toBeNull()
    expect(daysOpen(rfi({ status: 'cancelled' }), NOW)).toBeNull()
    expect(daysOpen(openRfi({ raisedDate: 'bad' }), NOW)).toBeNull()
  })
})

// ── Grouping ─────────────────────────────────────────────────────────────────

describe('grouping', () => {
  it('exposes six ordered, labelled groups', () => {
    expect(RFI_GROUP_ORDER).toHaveLength(6)
    for (const g of RFI_GROUP_ORDER) expect(typeof RFI_GROUP_LABELS[g]).toBe('string')
    expect(DUE_SOON_DAYS).toBe(7)
  })

  it('places each status and horizon correctly', () => {
    expect(rfiGroup(rfi(), NOW)).toBe(RFI_GROUP.DRAFT)
    expect(rfiGroup(openRfi({ dueDate: '2026-10-14' }), NOW)).toBe(RFI_GROUP.OVERDUE)
    expect(rfiGroup(openRfi({ dueDate: TODAY }), NOW)).toBe(RFI_GROUP.DUE_SOON)
    expect(rfiGroup(openRfi({ dueDate: '2026-10-22' }), NOW)).toBe(RFI_GROUP.DUE_SOON)  // exactly 7
    expect(rfiGroup(openRfi({ dueDate: '2026-10-23' }), NOW)).toBe(RFI_GROUP.OPEN)      // 8
    expect(rfiGroup(openRfi({ dueDate: null }), NOW)).toBe(RFI_GROUP.OPEN)
    expect(rfiGroup(rfi({ status: 'answered' }), NOW)).toBe(RFI_GROUP.AWAITING_CLOSE)
    expect(rfiGroup(rfi({ status: 'closed' }), NOW)).toBe(RFI_GROUP.CLOSED)
    expect(rfiGroup(rfi({ status: 'cancelled' }), NOW)).toBe(RFI_GROUP.CLOSED)
  })

  it('groupRfis returns every key, sorted within groups', () => {
    const list = [
      rfi({ id: 'a', rfiNumber: 'RFI-0001' }),
      rfi({ id: 'b', rfiNumber: 'RFI-0003' }),
      openRfi({ id: 'c', rfiNumber: 'RFI-0002', dueDate: '2026-10-01' }),
      rfi({ id: 'd', rfiNumber: 'RFI-0004', status: 'closed' }),
    ]
    const g = groupRfis(list, NOW)
    expect(Object.keys(g)).toEqual(RFI_GROUP_ORDER)
    expect(g[RFI_GROUP.DRAFT].map(r => r.id)).toEqual(['b', 'a'])
    expect(g[RFI_GROUP.OVERDUE].map(r => r.id)).toEqual(['c'])
    expect(g[RFI_GROUP.CLOSED].map(r => r.id)).toEqual(['d'])
    expect(g[RFI_GROUP.DUE_SOON]).toEqual([])
    expect(groupRfis(null, NOW)[RFI_GROUP.OPEN]).toEqual([])
  })
})

// ── Summary ──────────────────────────────────────────────────────────────────

describe('rfiSummary', () => {
  it('counts by status and overdue at read time', () => {
    const list = [
      rfi({ id: '1' }),
      openRfi({ id: '2', dueDate: '2026-10-01' }),
      openRfi({ id: '3', dueDate: '2026-11-01' }),
      openRfi({ id: '4', dueDate: null }),
      rfi({ id: '5', status: 'answered' }),
      rfi({ id: '6', status: 'closed' }),
      rfi({ id: '7', status: 'closed' }),
      rfi({ id: '8', status: 'cancelled' }),
    ]
    expect(rfiSummary(list, NOW)).toEqual({
      total: 8, draft: 1, open: 3, overdue: 1, awaitingClose: 1, closed: 2, cancelled: 1,
    })
  })

  it('an empty or null list summarises to zeros', () => {
    expect(rfiSummary([], NOW).total).toBe(0)
    expect(rfiSummary(null, NOW)).toEqual({
      total: 0, draft: 0, open: 0, overdue: 0, awaitingClose: 0, closed: 0, cancelled: 0,
    })
  })
})

// ── Sorting ──────────────────────────────────────────────────────────────────

describe('deterministic sort', () => {
  it('newest number first, unparseable last, ties by title then id', () => {
    const list = [
      rfi({ id: 'z', rfiNumber: 'RFI-0002', title: 'b' }),
      rfi({ id: 'y', rfiNumber: 'garbage', title: 'a' }),
      rfi({ id: 'x', rfiNumber: 'RFI-0010', title: 'c' }),
      rfi({ id: 'w', rfiNumber: 'RFI-0002', title: 'A' }),
      rfi({ id: 'v', rfiNumber: 'RFI-0002', title: 'b' }),
    ]
    expect(sortRfis(list).map(r => r.id)).toEqual(['x', 'w', 'v', 'z', 'y'])
  })

  it('is stable across shuffles', () => {
    const list = [
      rfi({ id: 'a', rfiNumber: 'RFI-0001' }),
      rfi({ id: 'b', rfiNumber: 'RFI-0002' }),
      rfi({ id: 'c', rfiNumber: 'RFI-0003' }),
    ]
    expect(sortRfis(list).map(r => r.id)).toEqual(sortRfis([...list].reverse()).map(r => r.id))
    expect(compareRfis(list[0], list[0])).toBe(0)
  })
})

// ── Filtering ────────────────────────────────────────────────────────────────

describe('filterRfis', () => {
  const list = [
    rfi({ id: '1', rfiNumber: 'RFI-0001', title: 'Slab thickness', question: 'Which governs?' }),
    openRfi({ id: '2', rfiNumber: 'RFI-0002', title: 'Lintel size', question: 'Confirm 150 PFC', dueDate: '2026-10-01', assignedToContactId: 'c1', assignedToName: 'Arch' }),
    openRfi({ id: '3', rfiNumber: 'RFI-0003', title: 'Door schedule', question: 'D12 missing', dueDate: '2026-11-01', assignedToContactId: 'c2', assignedToName: 'Eng' }),
    rfi({ id: '4', rfiNumber: 'RFI-0004', status: 'closed', title: 'Paint spec', question: 'Colour?' }),
  ]

  it('no filters returns everything', () => {
    expect(filterRfis(list, {}, NOW)).toHaveLength(4)
    expect(filterRfis(list, undefined, NOW)).toHaveLength(4)
    expect(filterRfis(null, {}, NOW)).toEqual([])
  })

  it('status filter', () => {
    expect(filterRfis(list, { status: 'open' }, NOW).map(r => r.id)).toEqual(['2', '3'])
    expect(filterRfis(list, { status: 'closed' }, NOW).map(r => r.id)).toEqual(['4'])
  })

  it('assignee filter', () => {
    expect(filterRfis(list, { assignedToContactId: 'c1' }, NOW).map(r => r.id)).toEqual(['2'])
    expect(filterRfis(list, { assignedToContactId: 'nobody' }, NOW)).toEqual([])
  })

  it('overdue only', () => {
    expect(filterRfis(list, { overdueOnly: true }, NOW).map(r => r.id)).toEqual(['2'])
  })

  it('search over number, title and question — case-insensitive', () => {
    expect(filterRfis(list, { search: 'rfi-0003' }, NOW).map(r => r.id)).toEqual(['3'])
    expect(filterRfis(list, { search: 'LINTEL' }, NOW).map(r => r.id)).toEqual(['2'])
    expect(filterRfis(list, { search: 'governs' }, NOW).map(r => r.id)).toEqual(['1'])
    expect(filterRfis(list, { search: '  colour ' }, NOW).map(r => r.id)).toEqual(['4'])
    expect(filterRfis(list, { search: 'Arch' }, NOW)).toEqual([])   // assignee name is NOT searched
  })

  it('filters combine', () => {
    expect(filterRfis(list, { status: 'open', assignedToContactId: 'c2' }, NOW).map(r => r.id)).toEqual(['3'])
    expect(filterRfis(list, { status: 'open', overdueOnly: true, search: 'door' }, NOW)).toEqual([])
  })

  it('assigneeOptions dedupes and sorts by name', () => {
    expect(assigneeOptions([...list, openRfi({ id: '5', assignedToContactId: 'c1', assignedToName: 'Arch' })]))
      .toEqual([{ id: 'c1', name: 'Arch' }, { id: 'c2', name: 'Eng' }])
    expect(assigneeOptions(null)).toEqual([])
  })
})

// ── Normalisation ────────────────────────────────────────────────────────────

describe('normaliseRfiDraft', () => {
  it('trims and truncates strings, nulls empty ids, nulls bad dates', () => {
    const d = normaliseRfiDraft({
      title: '  Slab  ', question: ' q ', raisedDate: ' 2026-10-10 ',
      referenceType: 'bogus', assignedToContactId: '', dueDate: 'nope',
      costCodeId: 'cc', costCodeName: 'x'.repeat(200),
    })
    expect(d.title).toBe('Slab')
    expect(d.question).toBe('q')
    expect(d.raisedDate).toBe('2026-10-10')
    expect(d.referenceType).toBe('none')
    expect(d.assignedToContactId).toBeNull()
    expect(d.dueDate).toBeNull()
    expect(d.costCodeName).toHaveLength(LIMITS.costCodeName)
  })

  it('produces exactly the authored field set', () => {
    expect(Object.keys(normaliseRfiDraft({})).sort()).toEqual([
      'assignedToContactId', 'assignedToName', 'costCodeId', 'costCodeName', 'dueDate',
      'question', 'raisedDate', 'referenceDocumentId', 'referenceDrawingId', 'referenceLabel',
      'referenceRevisionCode', 'referenceRevisionId', 'referenceType', 'title',
    ])
  })
})

// ── Presentation ─────────────────────────────────────────────────────────────

describe('presentation helpers', () => {
  it('formatIsoDate renders dd/mm/yyyy or a dash', () => {
    expect(formatIsoDate('2026-10-15')).toBe('15/10/2026')
    expect(formatIsoDate(null)).toBe('—')
  })

  it('dueLabel is text for every state', () => {
    expect(dueLabel(rfi(), NOW)).toMatch(/Draft/)
    expect(dueLabel(openRfi({ dueDate: '2026-10-14' }), NOW)).toBe('1 day overdue')
    expect(dueLabel(openRfi({ dueDate: '2026-10-05' }), NOW)).toBe('10 days overdue')
    expect(dueLabel(openRfi({ dueDate: TODAY }), NOW)).toBe('Due today')
    expect(dueLabel(openRfi({ dueDate: '2026-10-16' }), NOW)).toBe('Due tomorrow')
    expect(dueLabel(openRfi({ dueDate: '2026-10-20' }), NOW)).toBe('Due in 5 days')
    expect(dueLabel(openRfi({ dueDate: null }), NOW)).toBe('No due date')
    expect(dueLabel(rfi({ status: 'answered', raisedDate: '2026-10-10', answerDate: '2026-10-11' }), NOW)).toBe('Answered in 1 day')
    expect(dueLabel(rfi({ status: 'answered', raisedDate: '2026-10-10', answerDate: '2026-10-14' }), NOW)).toBe('Answered in 4 days')
    expect(dueLabel(rfi({ status: 'answered', answerDate: null }), NOW)).toBe('Answered')
    expect(dueLabel(rfi({ status: 'closed' }), NOW)).toBe('Closed')
    expect(dueLabel(rfi({ status: 'cancelled' }), NOW)).toBe('Cancelled')
    expect(dueLabel(null, NOW)).toBe('')
  })
})

// ── Purity ───────────────────────────────────────────────────────────────────

describe('purity — inputs are never mutated', () => {
  it('every exported function leaves frozen inputs intact', () => {
    const list = deepFreeze([
      rfi({ id: '1' }),
      openRfi({ id: '2', dueDate: '2026-10-01', ...drawingRef }),
      rfi({ id: '3', status: 'answered', answerDate: '2026-10-12' }),
      rfi({ id: '4', status: 'closed' }),
    ])
    const filters = deepFreeze({ search: 'slab', status: 'open', overdueOnly: true })
    const draft = deepFreeze(rfi({ ...drawingRef, dueDate: '2026-10-20' }))

    expect(() => {
      sortRfis(list); groupRfis(list, NOW); rfiSummary(list, NOW)
      filterRfis(list, filters, NOW); assigneeOptions(list)
      for (const r of list) {
        isOverdue(r, NOW); daysLate(r, NOW); daysUntilDue(r, NOW); daysOpen(r, NOW)
        responseDays(r); rfiGroup(r, NOW); dueLabel(r, NOW); referenceLabel(r)
      }
      normaliseRfiDraft(draft); validateRfiDraft(draft); validateRaise(draft)
      validateManagementDraft(draft, list[1]); validateAnswer({ answer: 'x', answerDate: '2026-10-14' }, list[1])
      validateClose('', list[2]); validateCancel('dup', list[1])
    }).not.toThrow()

    // sortRfis returns a new array, never the caller's.
    const sorted = sortRfis(list)
    expect(sorted).not.toBe(list)
  })
})
