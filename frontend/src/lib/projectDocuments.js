// ── General Project Documents ────────────────────────────────────────────────
//
// The flat, non-drawing document register: specifications, contracts, reports,
// certificates, safety documents, programmes, manuals, correspondence.
//
// DELIBERATELY SIMPLER THAN DRAWINGS. There is no revision subcollection and no
// current-revision pointer. A replacement is a NEW document record; the old one
// becomes `superseded` and links forward via `supersededByDocumentId`. Both
// files are preserved. Drawings need a revision spine because the site builds
// from a specific issue; a specification does not carry that risk.
//
// NO FOLDERS. Categories are a flat enum. A folder tree invites per-folder
// permissions, which is a membership redesign this branch explicitly excludes.

export const DOCUMENT_STATUS = {
  ACTIVE:     'active',
  SUPERSEDED: 'superseded',
  WITHDRAWN:  'withdrawn',
}

export const DOCUMENT_VISIBILITY = {
  PROJECT:  'project',   // every provisioned member of the company
  INTERNAL: 'internal',  // internal roles only
}

// The safe default. `project` is chosen deliberately over `internal`: a document
// uploaded to a project register is normally meant to be read, and a wrongly
// hidden safety document is the more dangerous mistake.
export const DEFAULT_DOCUMENT_VISIBILITY = DOCUMENT_VISIBILITY.PROJECT

// Roles permitted to upload, supersede, and withdraw general documents — and,
// by the same token, the roles permitted to read `internal` documents. The two
// sets coincide by definition: "internal" means "visible to the people who
// administer the register".
//
// ⚠️ UX MIRROR ONLY — Firestore and Storage Rules are the enforced boundary.
// QS IS included here (unlike drawings): a QS owns contracts, subcontracts and
// specifications, but not which drawing revision the site builds from.
export const DOCUMENT_WRITE_ROLES = ['company_admin', 'project_manager', 'qs']

export const canWriteDocuments = (role) => DOCUMENT_WRITE_ROLES.includes(role)

// Whether this role may see `internal` documents. Identical membership to
// `canWriteDocuments` today; named separately because they are different
// questions and could legitimately diverge later.
export const canReadInternalDocuments = (role) => DOCUMENT_WRITE_ROLES.includes(role)

export const DOCUMENT_CATEGORIES = [
  'specification',
  'contract',
  'subcontract',
  'report',
  'certificate',
  'safety',
  'schedule',
  'manual',
  'correspondence',
  'other',
]

const CATEGORY_LABELS = {
  specification:  'Specification',
  contract:       'Contract',
  subcontract:    'Subcontract',
  report:         'Report',
  certificate:    'Certificate',
  safety:         'Safety',
  schedule:       'Schedule / Programme',
  manual:         'Manual',
  correspondence: 'Correspondence',
  other:          'Other',
}

export const formatDocumentCategory = (c) => CATEGORY_LABELS[c] ?? c ?? '—'

const STATUS_LABELS = {
  active:     'Active',
  superseded: 'Superseded',
  withdrawn:  'Withdrawn',
}

export const formatDocumentStatus = (s) => STATUS_LABELS[s] ?? s ?? '—'

// Visibility is communicated in WORDS, never by colour alone.
const VISIBILITY_LABELS = {
  project:  'Project',
  internal: 'Internal',
}

export const formatDocumentVisibility = (v) => VISIBILITY_LABELS[v] ?? v ?? '—'

// ── Lifecycle legality ───────────────────────────────────────────────────────
//
// active     → superseded  (replaced by a newer record)
// active     → withdrawn   (recalled)
// superseded → withdrawn   (recalled after replacement)
// withdrawn  → nothing     (terminal)
//
// There is no un-supersede and no un-withdraw: correcting a mistake means
// uploading the correct record, never rewriting history. Nothing is ever
// hard-deleted.
const DOCUMENT_TRANSITIONS = {
  active:     ['superseded', 'withdrawn'],
  superseded: ['withdrawn'],
  withdrawn:  [],
}

export const canTransitionDocument = (from, to) =>
  (DOCUMENT_TRANSITIONS[from] ?? []).includes(to)

export const isInternalDocument  = (d) => d?.visibility === DOCUMENT_VISIBILITY.INTERNAL
export const isWithdrawnDocument = (d) => d?.status === DOCUMENT_STATUS.WITHDRAWN
export const isActiveDocument    = (d) => d?.status === DOCUMENT_STATUS.ACTIVE

// ── Validation ───────────────────────────────────────────────────────────────

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
export const isIsoDateShape = (v) => typeof v === 'string' && ISO_DATE.test(v)

// Returns an error string, or null when the document metadata is acceptable.
// The FILE is validated separately by lib/files.js.
export function validateDocumentDraft({ name, category, visibility, documentDate }) {
  if (!String(name ?? '').trim())                          return 'Enter a document name'
  if (!DOCUMENT_CATEGORIES.includes(category))             return 'Choose a category'
  if (!Object.values(DOCUMENT_VISIBILITY).includes(visibility)) return 'Choose a visibility'
  // The date is optional (plenty of documents carry no meaningful date), but a
  // supplied value must be a real 'YYYY-MM-DD'.
  if (documentDate && !isIsoDateShape(documentDate))       return 'Enter a valid document date'
  return null
}

export function validateWithdrawReason(reason) {
  return String(reason ?? '').trim() ? null : 'Enter a reason for withdrawing'
}

// ── Register ordering and filtering ──────────────────────────────────────────

// Newest document date first, undated last, then by name. Sorted HERE rather
// than in the Firestore query on purpose: non-internal roles subscribe with a
// `where('visibility','==','project')` filter, and combining that with a
// server-side `orderBy` on a different field would require a composite index.
// Sorting client-side keeps one ordering for both audiences and needs no index.
export function sortDocuments(documents) {
  return [...(documents ?? [])].sort((a, b) => {
    const da = a?.documentDate || ''
    const db = b?.documentDate || ''
    if (da !== db) return db.localeCompare(da)
    return String(a?.name ?? '').localeCompare(String(b?.name ?? ''))
  })
}

// Search matches name, category label, version label and notes. `includeWithdrawn`
// defaults to false so the register shows what is in force.
export function filterDocuments(documents, {
  search = '', category = '', visibility = '', includeWithdrawn = false,
} = {}) {
  const term = String(search ?? '').trim().toLowerCase()
  return (documents ?? []).filter(d => {
    if (!includeWithdrawn && isWithdrawnDocument(d)) return false
    if (category && d.category !== category) return false
    if (visibility && d.visibility !== visibility) return false
    if (!term) return true
    const haystack = [
      d.name,
      formatDocumentCategory(d.category),
      d.versionLabel,
      d.notes,
    ].map(v => String(v ?? '').toLowerCase())
    return haystack.some(v => v.includes(term))
  })
}
