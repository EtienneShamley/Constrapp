import { describe, it, expect } from 'vitest'
import {
  DOCUMENT_CATEGORIES, DOCUMENT_STATUS, DOCUMENT_VISIBILITY,
  DEFAULT_DOCUMENT_VISIBILITY, DOCUMENT_WRITE_ROLES,
  canWriteDocuments, canReadInternalDocuments, canTransitionDocument,
  validateDocumentDraft, validateWithdrawReason,
  sortDocuments, filterDocuments,
  formatDocumentCategory, formatDocumentStatus, formatDocumentVisibility,
  isInternalDocument, isWithdrawnDocument, isActiveDocument, isIsoDateShape,
} from '../../src/lib/projectDocuments.js'

// ── lib/projectDocuments.js — flat register, visibility, lifecycle ───────────

const doc = (over = {}) => ({
  id: 'x', name: 'Doc', category: 'specification', visibility: 'project',
  versionLabel: '', documentDate: '2026-01-01', notes: '', status: 'active', ...over,
})

describe('enumerations', () => {
  it('lists the ten flat categories — there are no folders', () => {
    expect(DOCUMENT_CATEGORIES).toEqual([
      'specification', 'contract', 'subcontract', 'report', 'certificate',
      'safety', 'schedule', 'manual', 'correspondence', 'other',
    ])
  })

  it('has exactly two visibilities and three statuses', () => {
    expect(DOCUMENT_VISIBILITY).toEqual({ PROJECT: 'project', INTERNAL: 'internal' })
    expect(DOCUMENT_STATUS).toEqual({
      ACTIVE: 'active', SUPERSEDED: 'superseded', WITHDRAWN: 'withdrawn',
    })
  })

  it('defaults to PROJECT visibility — a wrongly hidden document is the worse mistake', () => {
    expect(DEFAULT_DOCUMENT_VISIBILITY).toBe('project')
  })

  it('labels categories, statuses and visibilities in words', () => {
    expect(formatDocumentCategory('subcontract')).toBe('Subcontract')
    expect(formatDocumentCategory('schedule')).toBe('Schedule / Programme')
    expect(formatDocumentCategory(null)).toBe('—')
    expect(formatDocumentStatus('superseded')).toBe('Superseded')
    expect(formatDocumentVisibility('internal')).toBe('Internal')
    expect(formatDocumentVisibility('project')).toBe('Project')
  })
})

describe('write and internal-read roles', () => {
  it('permits document writes to company_admin, project_manager and qs', () => {
    expect(DOCUMENT_WRITE_ROLES).toEqual(['company_admin', 'project_manager', 'qs'])
    expect(canWriteDocuments('company_admin')).toBe(true)
    expect(canWriteDocuments('project_manager')).toBe(true)
    expect(canWriteDocuments('qs')).toBe(true)
  })

  it('INCLUDES qs here, unlike drawings', () => {
    expect(canWriteDocuments('qs')).toBe(true)
  })

  it('excludes subcontractor, client and super_admin from writes', () => {
    expect(canWriteDocuments('subcontractor')).toBe(false)
    expect(canWriteDocuments('client')).toBe(false)
    expect(canWriteDocuments('super_admin')).toBe(false)
    expect(canWriteDocuments(undefined)).toBe(false)
  })

  it('lets exactly the internal roles read internal documents', () => {
    expect(canReadInternalDocuments('company_admin')).toBe(true)
    expect(canReadInternalDocuments('project_manager')).toBe(true)
    expect(canReadInternalDocuments('qs')).toBe(true)
    expect(canReadInternalDocuments('subcontractor')).toBe(false)
    expect(canReadInternalDocuments('client')).toBe(false)
  })
})

describe('document transitions', () => {
  it('allows active -> superseded and active -> withdrawn', () => {
    expect(canTransitionDocument('active', 'superseded')).toBe(true)
    expect(canTransitionDocument('active', 'withdrawn')).toBe(true)
  })

  it('allows superseded -> withdrawn but never back to active', () => {
    expect(canTransitionDocument('superseded', 'withdrawn')).toBe(true)
    expect(canTransitionDocument('superseded', 'active')).toBe(false)
  })

  it('makes withdrawn terminal', () => {
    expect(canTransitionDocument('withdrawn', 'active')).toBe(false)
    expect(canTransitionDocument('withdrawn', 'superseded')).toBe(false)
  })

  it('rejects unknown states', () => {
    expect(canTransitionDocument('draft', 'active')).toBe(false)
    expect(canTransitionDocument(undefined, 'withdrawn')).toBe(false)
  })
})

describe('status predicates', () => {
  it('identifies internal, withdrawn and active documents', () => {
    expect(isInternalDocument(doc({ visibility: 'internal' }))).toBe(true)
    expect(isInternalDocument(doc())).toBe(false)
    expect(isWithdrawnDocument(doc({ status: 'withdrawn' }))).toBe(true)
    expect(isActiveDocument(doc())).toBe(true)
    expect(isActiveDocument(null)).toBe(false)
  })
})

describe('validateDocumentDraft', () => {
  const valid = {
    name: 'Structural Specification', category: 'specification',
    visibility: 'project', documentDate: '2026-08-11',
  }

  it('accepts a complete draft', () => {
    expect(validateDocumentDraft(valid)).toBeNull()
  })

  it('accepts a draft with NO document date — plenty of documents are undated', () => {
    expect(validateDocumentDraft({ ...valid, documentDate: '' })).toBeNull()
    expect(validateDocumentDraft({ ...valid, documentDate: null })).toBeNull()
  })

  it('requires a name that is not just whitespace', () => {
    expect(validateDocumentDraft({ ...valid, name: '   ' })).toBe('Enter a document name')
  })

  it('requires a category from the list', () => {
    expect(validateDocumentDraft({ ...valid, category: 'invoice' })).toBe('Choose a category')
  })

  it('requires a known visibility', () => {
    expect(validateDocumentDraft({ ...valid, visibility: 'public' })).toBe('Choose a visibility')
    expect(validateDocumentDraft({ ...valid, visibility: undefined })).toBe('Choose a visibility')
  })

  it('rejects a malformed document date when one is supplied', () => {
    expect(validateDocumentDraft({ ...valid, documentDate: '11/08/2026' }))
      .toBe('Enter a valid document date')
  })
})

describe('validateWithdrawReason', () => {
  it('requires a non-whitespace reason', () => {
    expect(validateWithdrawReason('Superseded by Rev C')).toBeNull()
    expect(validateWithdrawReason('  ')).toBe('Enter a reason for withdrawing')
  })
})

describe('isIsoDateShape', () => {
  it('accepts YYYY-MM-DD only', () => {
    expect(isIsoDateShape('2026-08-11')).toBe(true)
    expect(isIsoDateShape('2026/08/11')).toBe(false)
    expect(isIsoDateShape(null)).toBe(false)
  })
})

describe('sortDocuments', () => {
  it('sorts newest document date first', () => {
    const rows = [
      doc({ id: 'a', documentDate: '2026-01-01' }),
      doc({ id: 'b', documentDate: '2026-06-01' }),
    ]
    expect(sortDocuments(rows).map(d => d.id)).toEqual(['b', 'a'])
  })

  it('puts undated documents last', () => {
    const rows = [
      doc({ id: 'undated', documentDate: null }),
      doc({ id: 'dated', documentDate: '2026-01-01' }),
    ]
    expect(sortDocuments(rows).map(d => d.id)).toEqual(['dated', 'undated'])
  })

  it('breaks ties by name', () => {
    const rows = [
      doc({ id: 'z', name: 'Zeta', documentDate: '2026-01-01' }),
      doc({ id: 'a', name: 'Alpha', documentDate: '2026-01-01' }),
    ]
    expect(sortDocuments(rows).map(d => d.id)).toEqual(['a', 'z'])
  })

  it('does not mutate the input and tolerates null', () => {
    const rows = [doc({ id: 'a', documentDate: '2026-01-01' }), doc({ id: 'b', documentDate: '2026-06-01' })]
    sortDocuments(rows)
    expect(rows.map(d => d.id)).toEqual(['a', 'b'])
    expect(sortDocuments(null)).toEqual([])
  })
})

describe('filterDocuments', () => {
  const documents = [
    doc({ id: 'd1', name: 'Structural Specification', category: 'specification', visibility: 'project' }),
    doc({ id: 'd2', name: 'Head Contract',           category: 'contract',      visibility: 'internal' }),
    doc({ id: 'd3', name: 'Old Programme',           category: 'schedule',      status: 'withdrawn' }),
  ]

  it('hides withdrawn documents by default', () => {
    expect(filterDocuments(documents).map(d => d.id)).toEqual(['d1', 'd2'])
  })

  it('includes withdrawn documents when asked', () => {
    expect(filterDocuments(documents, { includeWithdrawn: true })).toHaveLength(3)
  })

  it('filters by category and by visibility', () => {
    expect(filterDocuments(documents, { category: 'contract' }).map(d => d.id)).toEqual(['d2'])
    expect(filterDocuments(documents, { visibility: 'internal' }).map(d => d.id)).toEqual(['d2'])
  })

  it('searches name, category label, version and notes', () => {
    expect(filterDocuments(documents, { search: 'structural' }).map(d => d.id)).toEqual(['d1'])
    expect(filterDocuments(documents, { search: 'Contract' }).map(d => d.id)).toEqual(['d2'])
    expect(filterDocuments(
      [doc({ id: 'v', versionLabel: 'Rev 4' }), doc({ id: 'n', notes: 'issued for construction' })],
      { search: 'rev 4' },
    ).map(d => d.id)).toEqual(['v'])
  })

  it('returns everything for an empty search and tolerates a null register', () => {
    expect(filterDocuments(documents, { search: '   ' })).toHaveLength(2)
    expect(filterDocuments(null)).toEqual([])
  })
})
