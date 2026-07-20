export const ENTITY_TYPE = {
  ORGANISATION: 'organisation',
  INDIVIDUAL:   'individual',
}

export const ENTITY_TYPE_LABELS = {
  [ENTITY_TYPE.ORGANISATION]: 'Organisation',
  [ENTITY_TYPE.INDIVIDUAL]:   'Individual',
}

export const CONTACT_TYPE = {
  SUPPLIER:      'supplier',
  SUBCONTRACTOR: 'subcontractor',
  CONSULTANT:    'consultant',
  CLIENT:        'client',
  OTHER:         'other',
}

export const CONTACT_TYPES = Object.values(CONTACT_TYPE)

export const CONTACT_TYPE_LABELS = {
  [CONTACT_TYPE.SUPPLIER]:      'Supplier',
  [CONTACT_TYPE.SUBCONTRACTOR]: 'Subcontractor',
  [CONTACT_TYPE.CONSULTANT]:    'Consultant',
  [CONTACT_TYPE.CLIENT]:        'Client',
  [CONTACT_TYPE.OTHER]:         'Other',
}

// Maps each contact type onto an existing Badge variant — no new colours.
export const CONTACT_TYPE_BADGE_VARIANTS = {
  [CONTACT_TYPE.SUPPLIER]:      'info',
  [CONTACT_TYPE.SUBCONTRACTOR]: 'active',
  [CONTACT_TYPE.CONSULTANT]:    'completed',
  [CONTACT_TYPE.CLIENT]:        'pending',
  [CONTACT_TYPE.OTHER]:         'soon',
}

// Types eligible to be picked as a supplier on a Purchase Order.
export const PO_SUPPLIER_TYPES = [CONTACT_TYPE.SUPPLIER, CONTACT_TYPE.SUBCONTRACTOR]

export const GST_STATUS = {
  UNKNOWN:        'unknown',
  REGISTERED:     'registered',
  NOT_REGISTERED: 'not_registered',
}

export const GST_STATUS_LABELS = {
  [GST_STATUS.UNKNOWN]:        'Unknown',
  [GST_STATUS.REGISTERED]:     'GST registered',
  [GST_STATUS.NOT_REGISTERED]: 'Not GST registered',
}

export const PAYMENT_TERMS_BASIS = {
  INVOICE: 'invoice',
  EOM:     'eom',
}

export const PAYMENT_TERMS_BASIS_LABELS = {
  [PAYMENT_TERMS_BASIS.INVOICE]: 'Days after invoice',
  [PAYMENT_TERMS_BASIS.EOM]:     'Days after end of month',
}

// tradingName || legalName for organisations; "First Last" for individuals.
export function contactDisplayName({ entityType, tradingName, legalName, firstName, lastName }) {
  if (entityType === ENTITY_TYPE.INDIVIDUAL) {
    return [firstName, lastName].map(s => (s || '').trim()).filter(Boolean).join(' ')
  }
  return (tradingName || '').trim() || (legalName || '').trim()
}

// ── Project assignments ──────────────────────────────────────────────────────

export const PROJECT_ASSIGNMENT_STATUS = {
  ACTIVE: 'active',
}

// Per-project fields beyond projectId; trade/projectRole/scope/notes are stored
// now but have no editing UI yet — normalisation must carry existing values.
export const PROJECT_ASSIGNMENT_DEFAULTS = {
  trade:       '',
  projectRole: '',
  scope:       '',
  status:      PROJECT_ASSIGNMENT_STATUS.ACTIVE,
  notes:       '',
}

// Drops entries without a projectId, keeps the first assignment per projectId,
// and fills defaults while preserving any already-stored per-project values.
export function normaliseProjectAssignments(assignments) {
  const seen   = new Set()
  const result = []
  for (const assignment of assignments ?? []) {
    const projectId = typeof assignment?.projectId === 'string' ? assignment.projectId.trim() : ''
    if (!projectId || seen.has(projectId)) continue
    seen.add(projectId)
    result.push({
      projectId,
      trade:       assignment.trade?.trim()       || PROJECT_ASSIGNMENT_DEFAULTS.trade,
      projectRole: assignment.projectRole?.trim() || PROJECT_ASSIGNMENT_DEFAULTS.projectRole,
      scope:       assignment.scope?.trim()       || PROJECT_ASSIGNMENT_DEFAULTS.scope,
      status:      assignment.status              || PROJECT_ASSIGNMENT_DEFAULTS.status,
      notes:       assignment.notes?.trim()       || PROJECT_ASSIGNMENT_DEFAULTS.notes,
    })
  }
  return result
}

// projectIds is always derived from projectAssignments — never edited directly.
export const projectIdsFromAssignments = (assignments) =>
  [...new Set((assignments ?? []).map(a => a?.projectId).filter(Boolean))]

// Contacts without assignment fields (pre-dating this feature) are unassigned.
export const isAssignedToProject = (contact, projectId) =>
  !!projectId && (contact?.projectIds ?? []).includes(projectId)

// ── ABN ──────────────────────────────────────────────────────────────────────

export const normaliseAbn = (input) => String(input || '').replace(/\D/g, '')

// Mod-89 checksum defined by the ABR: subtract 1 from the first digit, then the
// weighted digit sum must divide evenly by 89.
const ABN_WEIGHTS = [10, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19]

export function isValidAbn(input) {
  const digits = normaliseAbn(input)
  if (digits.length !== 11) return false
  const sum = ABN_WEIGHTS.reduce((acc, weight, i) => {
    const digit = Number(digits[i]) - (i === 0 ? 1 : 0)
    return acc + digit * weight
  }, 0)
  return sum % 89 === 0
}

// 'XX XXX XXX XXX'; non-11-digit values render as entered.
export function formatAbn(input) {
  const digits = normaliseAbn(input)
  if (digits.length !== 11) return input || ''
  return `${digits.slice(0, 2)} ${digits.slice(2, 5)} ${digits.slice(5, 8)} ${digits.slice(8, 11)}`
}

// ── Validation ───────────────────────────────────────────────────────────────

// Returns an error message, or null when the candidate contact is saveable.
export function validateContact({ entityType, contactTypes, legalName, firstName, lastName, abn, country }) {
  if (!Object.values(ENTITY_TYPE).includes(entityType)) return 'Choose organisation or individual.'
  if (!Array.isArray(contactTypes) || contactTypes.length === 0) return 'Select at least one contact type.'
  if (contactTypes.some(t => !CONTACT_TYPES.includes(t))) return 'Unknown contact type.'
  if (entityType === ENTITY_TYPE.ORGANISATION && !(legalName || '').trim()) return 'Legal name is required.'
  if (entityType === ENTITY_TYPE.INDIVIDUAL) {
    if (!(firstName || '').trim()) return 'First name is required.'
    if (!(lastName || '').trim())  return 'Last name is required.'
  }
  const digits = normaliseAbn(abn)
  if (digits && country === 'AU' && !isValidAbn(digits)) return 'Invalid Australian ABN — check the 11 digits.'
  return null
}

// ── Duplicate detection ──────────────────────────────────────────────────────

const contactEmails = (contact) => [
  (contact.email || '').trim().toLowerCase(),
  ...(contact.people ?? []).map(p => (p.email || '').trim().toLowerCase()),
].filter(Boolean)

// Warn-only checks against the in-memory contact list. Returns
// [{ field, message }] — duplicates never block saving (branches of one entity
// legitimately share an ABN), except the checksum failure caught in validation.
export function duplicateWarnings(contacts, { id = null, abn = '', email = '', displayName = '', peopleEmails = [] }) {
  const warnings  = []
  const candAbn   = normaliseAbn(abn)
  const candName  = (displayName || '').trim().toLowerCase()
  const candEmails = [
    (email || '').trim().toLowerCase(),
    ...peopleEmails.map(e => (e || '').trim().toLowerCase()),
  ].filter(Boolean)

  for (const contact of contacts) {
    if (id && contact.id === id) continue
    const theirName = contact.nameLower || ''

    if (candAbn && normaliseAbn(contact.abn) === candAbn) {
      warnings.push({ field: 'abn', message: `ABN matches "${contact.displayName}".` })
    }
    if (candName && theirName === candName) {
      warnings.push({ field: 'name', message: `A contact named "${contact.displayName}" already exists.` })
    } else if (candName.length >= 4 && theirName && (theirName.includes(candName) || candName.includes(theirName))) {
      warnings.push({ field: 'name', message: `Similar name: "${contact.displayName}".` })
    }
    const shared = contactEmails(contact).find(e => candEmails.includes(e))
    if (shared) {
      warnings.push({ field: 'email', message: `Email ${shared} is already on "${contact.displayName}".` })
    }
  }
  return warnings
}
