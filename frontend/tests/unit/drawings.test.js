import { describe, it, expect } from 'vitest'
import {
  DISCIPLINES, DRAWING_STATUS, REVISION_STATUS, REVISION_SCHEMA_VERSION,
  DRAWING_WRITE_ROLES, CONCURRENT_REVISION_MESSAGE,
  canWriteDrawings, canTransitionRevision, canTransitionDrawing,
  normaliseDrawingNumber, normaliseRevisionCode,
  findDuplicateDrawingNumber, findDuplicateRevisionCode,
  sortRevisions, nextRevisionSequence, currentRevision, reinstatableRevisions,
  validateDrawingDraft, validateRevisionDraft, validateWithdrawReason,
  filterDrawings, revisionWarning,
  formatDiscipline, formatRevisionStatus, isIsoDateShape,
  isCurrentRevision, isSupersededRevision, isWithdrawnRevision, isWithdrawnDrawing,
} from '../../src/lib/drawings.js'

// ── lib/drawings.js — masters, immutable revisions, lifecycle ────────────────

const rev = (id, code, sequence, status = 'superseded', revisionDate = '2026-01-01') =>
  ({ id, revisionCode: code, revisionSequence: sequence, status, revisionDate })

describe('enumerations', () => {
  it('lists the eight disciplines in the agreed order', () => {
    expect(DISCIPLINES).toEqual([
      'architectural', 'structural', 'civil', 'mechanical',
      'electrical', 'hydraulic', 'landscape', 'other',
    ])
  })

  it('has two master statuses and three revision statuses', () => {
    expect(DRAWING_STATUS).toEqual({ ACTIVE: 'active', WITHDRAWN: 'withdrawn' })
    expect(REVISION_STATUS).toEqual({
      CURRENT: 'current', SUPERSEDED: 'superseded', WITHDRAWN: 'withdrawn',
    })
  })

  it('stamps revisions with schema version 1', () => {
    expect(REVISION_SCHEMA_VERSION).toBe(1)
  })

  it('labels every discipline and revision status', () => {
    expect(formatDiscipline('hydraulic')).toBe('Hydraulic')
    expect(formatDiscipline('unknown')).toBe('unknown')
    expect(formatDiscipline(null)).toBe('—')
    expect(formatRevisionStatus('superseded')).toBe('Superseded')
    expect(formatRevisionStatus(null)).toBe('—')
  })
})

describe('write roles', () => {
  it('permits drawing writes to company_admin and project_manager only', () => {
    expect(DRAWING_WRITE_ROLES).toEqual(['company_admin', 'project_manager'])
    expect(canWriteDrawings('company_admin')).toBe(true)
    expect(canWriteDrawings('project_manager')).toBe(true)
  })

  it('EXCLUDES qs from drawing writes in this branch', () => {
    expect(canWriteDrawings('qs')).toBe(false)
  })

  it('excludes subcontractor, client, super_admin and unknown roles', () => {
    expect(canWriteDrawings('subcontractor')).toBe(false)
    expect(canWriteDrawings('client')).toBe(false)
    expect(canWriteDrawings('super_admin')).toBe(false)
    expect(canWriteDrawings(undefined)).toBe(false)
  })
})

describe('revision transitions', () => {
  it('allows current -> superseded and current -> withdrawn', () => {
    expect(canTransitionRevision('current', 'superseded')).toBe(true)
    expect(canTransitionRevision('current', 'withdrawn')).toBe(true)
  })

  it('allows superseded -> current (explicit reinstatement) and -> withdrawn', () => {
    expect(canTransitionRevision('superseded', 'current')).toBe(true)
    expect(canTransitionRevision('superseded', 'withdrawn')).toBe(true)
  })

  it('makes withdrawn terminal', () => {
    expect(canTransitionRevision('withdrawn', 'current')).toBe(false)
    expect(canTransitionRevision('withdrawn', 'superseded')).toBe(false)
    expect(canTransitionRevision('withdrawn', 'withdrawn')).toBe(false)
  })

  it('rejects unknown states and self-transitions', () => {
    expect(canTransitionRevision('current', 'current')).toBe(false)
    expect(canTransitionRevision('draft', 'current')).toBe(false)
    expect(canTransitionRevision(undefined, 'current')).toBe(false)
  })
})

describe('drawing transitions', () => {
  it('allows active -> withdrawn only, and makes it terminal', () => {
    expect(canTransitionDrawing('active', 'withdrawn')).toBe(true)
    expect(canTransitionDrawing('withdrawn', 'active')).toBe(false)
    expect(canTransitionDrawing('active', 'active')).toBe(false)
  })
})

describe('status predicates', () => {
  it('identifies each revision status and a withdrawn master', () => {
    expect(isCurrentRevision({ status: 'current' })).toBe(true)
    expect(isSupersededRevision({ status: 'superseded' })).toBe(true)
    expect(isWithdrawnRevision({ status: 'withdrawn' })).toBe(true)
    expect(isWithdrawnDrawing({ status: 'withdrawn' })).toBe(true)
    expect(isCurrentRevision(null)).toBe(false)
    expect(isWithdrawnDrawing({ status: 'active' })).toBe(false)
  })
})

describe('normalisation', () => {
  it('trims, collapses whitespace and upper-cases a drawing number', () => {
    expect(normaliseDrawingNumber('  a-101  ')).toBe('A-101')
    expect(normaliseDrawingNumber('A  101')).toBe('A 101')
    expect(normaliseDrawingNumber(null)).toBe('')
  })

  it('strips ALL whitespace from a revision code and upper-cases it', () => {
    expect(normaliseRevisionCode(' p 1 ')).toBe('P1')
    expect(normaliseRevisionCode('b')).toBe('B')
    expect(normaliseRevisionCode(undefined)).toBe('')
  })
})

describe('duplicate detection (warning only)', () => {
  const drawings = [
    { id: 'd1', drawingNumber: 'A-101', title: 'Ground Floor Plan' },
    { id: 'd2', drawingNumber: 'S-201', title: 'Footing Details' },
  ]

  it('finds a duplicate regardless of case and spacing', () => {
    expect(findDuplicateDrawingNumber(drawings, ' a-101 ')?.id).toBe('d1')
  })

  it('returns null when the number is free', () => {
    expect(findDuplicateDrawingNumber(drawings, 'E-301')).toBeNull()
  })

  it('excludes the drawing being edited from its own duplicate check', () => {
    expect(findDuplicateDrawingNumber(drawings, 'A-101', 'd1')).toBeNull()
  })

  it('returns null for an empty number and an empty register', () => {
    expect(findDuplicateDrawingNumber(drawings, '   ')).toBeNull()
    expect(findDuplicateDrawingNumber(null, 'A-101')).toBeNull()
  })

  it('finds a duplicate revision code within one drawing', () => {
    const revisions = [rev('r1', 'A', 1), rev('r2', 'B', 2, 'current')]
    expect(findDuplicateRevisionCode(revisions, 'b')?.id).toBe('r2')
    expect(findDuplicateRevisionCode(revisions, 'C')).toBeNull()
    expect(findDuplicateRevisionCode(revisions, '')).toBeNull()
  })
})

describe('revision ordering', () => {
  it('orders by revisionSequence descending, NEVER by revision code', () => {
    // Codes here sort lexically as ['A', 'B', 'C10', 'C2'] — the wrong order.
    const revisions = [
      rev('r1', 'A', 1),
      rev('r4', 'C10', 4, 'current'),
      rev('r2', 'B', 2),
      rev('r3', 'C2', 3),
    ]
    expect(sortRevisions(revisions).map(r => r.revisionCode)).toEqual(['C10', 'C2', 'B', 'A'])
  })

  it('does not mutate the input array', () => {
    const revisions = [rev('r1', 'A', 1), rev('r2', 'B', 2)]
    sortRevisions(revisions)
    expect(revisions.map(r => r.id)).toEqual(['r1', 'r2'])
  })

  it('tolerates missing sequences and an empty list', () => {
    expect(sortRevisions([{ id: 'x' }, rev('r1', 'A', 1)])[0].id).toBe('r1')
    expect(sortRevisions(null)).toEqual([])
  })

  it('derives the next sequence as revisionCount + 1', () => {
    expect(nextRevisionSequence({ revisionCount: 0 })).toBe(1)
    expect(nextRevisionSequence({ revisionCount: 7 })).toBe(8)
    expect(nextRevisionSequence({})).toBe(1)
    expect(nextRevisionSequence(null)).toBe(1)
  })
})

describe('currentRevision', () => {
  const revisions = [rev('r1', 'A', 1), rev('r2', 'B', 2, 'current')]

  it('resolves the master pointer', () => {
    expect(currentRevision({ currentRevisionId: 'r2' }, revisions)?.revisionCode).toBe('B')
  })

  it('falls back to the revision carrying status current when there is no pointer', () => {
    expect(currentRevision({ currentRevisionId: null }, revisions)?.id).toBe('r2')
  })

  it('returns null when the pointer names a revision that is not loaded', () => {
    expect(currentRevision({ currentRevisionId: 'gone' }, revisions)).toBeNull()
  })

  it('returns null for a drawing with no revisions', () => {
    expect(currentRevision({ currentRevisionId: null }, [])).toBeNull()
  })
})

describe('reinstatableRevisions', () => {
  const revisions = [
    rev('r1', 'A', 1),
    rev('r2', 'B', 2),
    rev('r3', 'C', 3, 'current'),
    rev('r4', 'D', 4, 'withdrawn'),
  ]

  it('offers earlier non-withdrawn revisions, newest first', () => {
    expect(reinstatableRevisions(revisions, 'r3').map(r => r.id)).toEqual(['r2', 'r1'])
  })

  it('never offers a withdrawn revision — withdrawal is terminal', () => {
    expect(reinstatableRevisions(revisions, 'r3').some(r => r.id === 'r4')).toBe(false)
  })

  it('never offers the revision being withdrawn', () => {
    expect(reinstatableRevisions(revisions, 'r2').some(r => r.id === 'r2')).toBe(false)
  })

  it('returns an empty list when there is nothing to reinstate', () => {
    expect(reinstatableRevisions([rev('r1', 'A', 1, 'current')], 'r1')).toEqual([])
  })
})

describe('validateDrawingDraft', () => {
  const valid = { drawingNumber: 'A-101', title: 'Ground Floor Plan', discipline: 'architectural' }

  it('accepts a complete draft', () => {
    expect(validateDrawingDraft(valid)).toBeNull()
  })

  it('requires a drawing number that is not just whitespace', () => {
    expect(validateDrawingDraft({ ...valid, drawingNumber: '   ' })).toBe('Enter a drawing number')
  })

  it('requires a title', () => {
    expect(validateDrawingDraft({ ...valid, title: ' ' })).toBe('Enter a drawing title')
  })

  it('requires a discipline from the list', () => {
    expect(validateDrawingDraft({ ...valid, discipline: 'plumbing' })).toBe('Choose a discipline')
    expect(validateDrawingDraft({ ...valid, discipline: undefined })).toBe('Choose a discipline')
  })
})

describe('validateRevisionDraft', () => {
  const valid = { revisionCode: 'B', revisionDate: '2026-08-11' }

  it('accepts a complete draft', () => {
    expect(validateRevisionDraft(valid)).toBeNull()
  })

  it('requires a revision code', () => {
    expect(validateRevisionDraft({ ...valid, revisionCode: '  ' })).toBe('Enter a revision code')
  })

  it('rejects a revision code over 12 characters', () => {
    expect(validateRevisionDraft({ ...valid, revisionCode: 'A'.repeat(13) }))
      .toBe('Revision code is too long (max 12 characters)')
  })

  it('requires a YYYY-MM-DD revision date', () => {
    expect(validateRevisionDraft({ ...valid, revisionDate: '11/08/2026' })).toBe('Enter the revision date')
    expect(validateRevisionDraft({ ...valid, revisionDate: '' })).toBe('Enter the revision date')
  })
})

describe('validateWithdrawReason', () => {
  it('requires a non-whitespace reason', () => {
    expect(validateWithdrawReason('Issued in error')).toBeNull()
    expect(validateWithdrawReason('   ')).toBe('Enter a reason for withdrawing')
    expect(validateWithdrawReason(null)).toBe('Enter a reason for withdrawing')
  })
})

describe('isIsoDateShape', () => {
  it('accepts YYYY-MM-DD and rejects everything else', () => {
    expect(isIsoDateShape('2026-08-11')).toBe(true)
    expect(isIsoDateShape('2026-8-11')).toBe(false)
    expect(isIsoDateShape(20260811)).toBe(false)
    expect(isIsoDateShape(null)).toBe(false)
  })
})

describe('filterDrawings', () => {
  const drawings = [
    { id: 'd1', drawingNumber: 'A-101', title: 'Ground Floor Plan', discipline: 'architectural', currentRevisionCode: 'P1', status: 'active' },
    { id: 'd2', drawingNumber: 'S-201', title: 'Footing Details',   discipline: 'structural',    currentRevisionCode: 'A', status: 'active' },
    { id: 'd3', drawingNumber: 'A-999', title: 'Old Plan',          discipline: 'architectural', currentRevisionCode: '',  status: 'withdrawn' },
  ]

  it('hides withdrawn drawings by default — the safe register view', () => {
    expect(filterDrawings(drawings).map(d => d.id)).toEqual(['d1', 'd2'])
  })

  it('includes withdrawn drawings when explicitly asked', () => {
    expect(filterDrawings(drawings, { includeWithdrawn: true })).toHaveLength(3)
  })

  it('filters by discipline', () => {
    expect(filterDrawings(drawings, { discipline: 'structural' }).map(d => d.id)).toEqual(['d2'])
  })

  it('searches number, title, discipline label and current revision code', () => {
    expect(filterDrawings(drawings, { search: 'a-101' }).map(d => d.id)).toEqual(['d1'])
    expect(filterDrawings(drawings, { search: 'footing' }).map(d => d.id)).toEqual(['d2'])
    expect(filterDrawings(drawings, { search: 'Structural' }).map(d => d.id)).toEqual(['d2'])
    expect(filterDrawings(drawings, { search: 'p1' }).map(d => d.id)).toEqual(['d1'])
  })

  it('returns everything for an empty search and nothing for no match', () => {
    expect(filterDrawings(drawings, { search: '  ' })).toHaveLength(2)
    expect(filterDrawings(drawings, { search: 'zzz' })).toHaveLength(0)
  })

  it('tolerates a null register', () => {
    expect(filterDrawings(null)).toEqual([])
  })
})

describe('revisionWarning', () => {
  const drawing = { status: 'active', currentRevisionCode: 'C' }

  it('gives no warning for the current revision of an active drawing', () => {
    expect(revisionWarning(rev('r3', 'C', 3, 'current'), drawing)).toBeNull()
  })

  it('names the superseded revision AND the current one, in words', () => {
    const warning = revisionWarning(rev('r2', 'B', 2, 'superseded'), drawing)
    expect(warning.tone).toBe('superseded')
    expect(warning.title).toBe('SUPERSEDED — Revision B')
    expect(warning.body).toBe('Do not build from this drawing. Current revision is C.')
  })

  it('still warns when a superseded revision has no current replacement', () => {
    const warning = revisionWarning(rev('r2', 'B', 2, 'superseded'), { status: 'active', currentRevisionCode: '' })
    expect(warning.body).toBe('Do not build from this drawing. This drawing has no current revision.')
  })

  it('warns unmistakably on a withdrawn revision', () => {
    const warning = revisionWarning(rev('r1', 'A', 1, 'withdrawn'), drawing)
    expect(warning.tone).toBe('withdrawn')
    expect(warning.title).toBe('WITHDRAWN')
    expect(warning.body).toBe('Do not use this drawing.')
  })

  it('warns on a current revision whose MASTER has been withdrawn', () => {
    const warning = revisionWarning(rev('r3', 'C', 3, 'current'), { status: 'withdrawn' })
    expect(warning.title).toBe('WITHDRAWN')
  })

  it('returns null when there is no revision', () => {
    expect(revisionWarning(null, drawing)).toBeNull()
  })
})

describe('concurrency message', () => {
  it('tells the user to review the drawing rather than implying a retry succeeded', () => {
    expect(CONCURRENT_REVISION_MESSAGE)
      .toBe('Another user issued a revision while you were uploading. Review the drawing before re-issuing.')
  })
})
