import { useMemo, useState } from 'react'
import PageHeader from '../components/PageHeader'
import Card from '../components/Card'
import Btn from '../components/Btn'
import Badge from '../components/Badge'
import { useContacts } from '../hooks/useContacts'
import { useProjects } from '../hooks/useProjects'
import {
  ENTITY_TYPE, ENTITY_TYPE_LABELS,
  CONTACT_TYPES, CONTACT_TYPE_LABELS, CONTACT_TYPE_BADGE_VARIANTS,
  GST_STATUS, GST_STATUS_LABELS,
  PAYMENT_TERMS_BASIS, PAYMENT_TERMS_BASIS_LABELS,
  PROJECT_ASSIGNMENT_DEFAULTS,
  contactDisplayName, formatAbn, normaliseAbn, isValidAbn,
  validateContact, duplicateWarnings,
} from '../lib/contacts'

const inputCls = 'w-full bg-brand-bg border border-brand-border rounded-lg px-3 py-2 text-[13px] text-brand-text placeholder:text-brand-muted focus:border-brand-accent focus:outline-none'
const labelCls = 'block text-[11px] font-bold text-brand-muted uppercase tracking-[0.4px] mb-1.5'
const thCls    = 'text-left px-3.5 py-[10px] text-brand-muted text-[11px] font-bold uppercase tracking-[0.4px]'

const COUNTRIES = [
  { value: 'AU', label: 'Australia' },
  { value: 'NZ', label: 'New Zealand' },
  { value: 'GB', label: 'United Kingdom' },
  { value: 'US', label: 'United States' },
  { value: 'other', label: 'Other' },
]

const newPersonId = () =>
  (globalThis.crypto?.randomUUID ? crypto.randomUUID() : `p_${Date.now()}_${Math.random().toString(36).slice(2)}`)

const EMPTY_PERSON = { name: '', jobTitle: '', email: '', phone: '', notes: '' }

const EMPTY_FORM = {
  entityType:   ENTITY_TYPE.ORGANISATION,
  contactTypes: [],
  legalName: '', tradingName: '', firstName: '', lastName: '',
  abn: '', country: 'AU', email: '', phone: '',
  street: '', suburb: '', state: '', postcode: '',
  trades: '', paymentDays: '', paymentBasis: PAYMENT_TERMS_BASIS.INVOICE,
  gstStatus: GST_STATUS.UNKNOWN, notes: '',
  people: [], primaryPersonId: null,
  projectAssignments: [],
}

function formFromContact(contact) {
  return {
    entityType:   contact.entityType,
    contactTypes: [...(contact.contactTypes ?? [])],
    legalName:    contact.legalName   || '',
    tradingName:  contact.tradingName || '',
    firstName:    contact.firstName   || '',
    lastName:     contact.lastName    || '',
    abn:          contact.abn         || '',
    country:      contact.country     || 'AU',
    email:        contact.email       || '',
    phone:        contact.phone       || '',
    street:       contact.address?.street   || '',
    suburb:       contact.address?.suburb   || '',
    state:        contact.address?.state    || '',
    postcode:     contact.address?.postcode || '',
    trades:       (contact.trades ?? []).join(', '),
    paymentDays:  contact.paymentTerms?.days  != null ? String(contact.paymentTerms.days) : '',
    paymentBasis: contact.paymentTerms?.basis || PAYMENT_TERMS_BASIS.INVOICE,
    gstStatus:    contact.gstStatus || GST_STATUS.UNKNOWN,
    notes:        contact.notes || '',
    people:       (contact.people ?? []).map(p => ({ ...p })),
    primaryPersonId: contact.primaryPersonId ?? null,
    projectAssignments: (contact.projectAssignments ?? []).map(a => ({ ...a })),
  }
}

// Form state → the shape useContacts persists.
function dataFromForm(form) {
  return {
    entityType:   form.entityType,
    contactTypes: form.contactTypes,
    legalName:    form.legalName,
    tradingName:  form.tradingName,
    firstName:    form.firstName,
    lastName:     form.lastName,
    abn:          form.abn,
    country:      form.country,
    email:        form.email,
    phone:        form.phone,
    address:      { street: form.street, suburb: form.suburb, state: form.state, postcode: form.postcode },
    trades:       form.trades.split(','),
    paymentTerms: { days: form.paymentDays, basis: form.paymentBasis },
    gstStatus:    form.gstStatus,
    notes:        form.notes,
    people:       form.people,
    primaryPersonId: form.primaryPersonId,
    projectAssignments: form.projectAssignments,
  }
}

function ContactFormModal({ contact, contacts, projects, projectsLoading, onClose, onSave, title }) {
  const isEdit = !!contact
  const [form, setForm]     = useState(isEdit ? formFromContact(contact) : EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const [error, setError]   = useState(null)

  const set = (key) => (e) => setForm(f => ({ ...f, [key]: e.target.value }))
  const isOrg = form.entityType === ENTITY_TYPE.ORGANISATION
  // Archived contacts keep and may drop existing assignments but gain no new ones.
  const isArchived = isEdit && contact.isActive === false

  const isAssignedInForm = (projectId) => form.projectAssignments.some(a => a.projectId === projectId)
  const toggleProject = (projectId) => () => setForm(f => ({
    ...f,
    projectAssignments: f.projectAssignments.some(a => a.projectId === projectId)
      ? f.projectAssignments.filter(a => a.projectId !== projectId)
      : [...f.projectAssignments, { projectId, ...PROJECT_ASSIGNMENT_DEFAULTS }],
  }))
  // Assignments whose project isn't in the live list (shouldn't happen — projects
  // can't be deleted) stay visible and removable rather than silently dropped.
  const unknownAssignments = projectsLoading
    ? []
    : form.projectAssignments.filter(a => !projects.some(p => p.id === a.projectId))

  const toggleType = (type) => () => setForm(f => ({
    ...f,
    contactTypes: f.contactTypes.includes(type)
      ? f.contactTypes.filter(t => t !== type)
      : [...f.contactTypes, type],
  }))

  const addPerson    = () => setForm(f => ({ ...f, people: [...f.people, { ...EMPTY_PERSON, id: newPersonId() }] }))
  const removePerson = (id) => setForm(f => ({
    ...f,
    people: f.people.filter(p => p.id !== id),
    primaryPersonId: f.primaryPersonId === id ? null : f.primaryPersonId,
  }))
  const setPerson = (id, key) => (e) => {
    const value = e.target.value
    setForm(f => ({ ...f, people: f.people.map(p => (p.id === id ? { ...p, [key]: value } : p)) }))
  }
  const setPrimary = (id) => () => setForm(f => ({ ...f, primaryPersonId: f.primaryPersonId === id ? null : id }))

  const displayName     = contactDisplayName(form)
  const abnDigits       = normaliseAbn(form.abn)
  const abnInvalid      = !!abnDigits && form.country === 'AU' && !isValidAbn(abnDigits)
  const validationError = validateContact(form)
  const warnings = useMemo(() => duplicateWarnings(contacts, {
    id: contact?.id ?? null,
    abn: form.abn,
    email: form.email,
    displayName,
    peopleEmails: form.people.map(p => p.email),
  }), [contacts, contact, form.abn, form.email, displayName, form.people])

  async function handleSubmit(e) {
    e.preventDefault()
    if (validationError) return
    setSaving(true)
    setError(null)
    try {
      await onSave(dataFromForm(form))
      onClose()
    } catch (err) {
      setError(err?.message || 'Failed to save. Check your connection and try again.')
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative z-10 w-full max-w-[760px] max-h-[90vh] overflow-y-auto bg-brand-surface border border-brand-border rounded-xl shadow-2xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-brand-border">
          <h2 className="text-[15px] font-bold text-brand-text m-0">{title ?? (isEdit ? `Edit ${contact.displayName}` : 'New Contact')}</h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="text-brand-muted hover:text-brand-text text-xl leading-none cursor-pointer min-w-[44px] min-h-[44px] flex items-center justify-center"
          >
            ×
          </button>
        </div>

        <form onSubmit={handleSubmit} className="px-5 py-4 flex flex-col gap-3.5">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className={labelCls}>Contact Kind</label>
              <select className={inputCls} value={form.entityType} onChange={set('entityType')} disabled={isEdit}>
                {Object.values(ENTITY_TYPE).map(t => (
                  <option key={t} value={t}>{ENTITY_TYPE_LABELS[t]}</option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelCls}>
                Contact Types <span className="text-brand-red">*</span>
              </label>
              <div className="flex flex-wrap gap-x-3 gap-y-1.5 pt-1.5">
                {CONTACT_TYPES.map(type => (
                  <label key={type} className="flex items-center gap-1.5 text-[13px] text-brand-text cursor-pointer min-h-[24px]">
                    <input
                      type="checkbox"
                      checked={form.contactTypes.includes(type)}
                      onChange={toggleType(type)}
                      className="accent-[#00C9A7]"
                    />
                    {CONTACT_TYPE_LABELS[type]}
                  </label>
                ))}
              </div>
            </div>
          </div>

          {isOrg ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className={labelCls}>
                  Legal Name <span className="text-brand-red">*</span>
                </label>
                <input className={inputCls} placeholder="e.g. Boral Resources (NSW) Pty Ltd" value={form.legalName} onChange={set('legalName')} autoFocus={!isEdit} />
              </div>
              <div>
                <label className={labelCls}>Trading Name</label>
                <input className={inputCls} placeholder="e.g. Boral Concrete" value={form.tradingName} onChange={set('tradingName')} />
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className={labelCls}>
                  First Name <span className="text-brand-red">*</span>
                </label>
                <input className={inputCls} value={form.firstName} onChange={set('firstName')} autoFocus={!isEdit} />
              </div>
              <div>
                <label className={labelCls}>
                  Last Name <span className="text-brand-red">*</span>
                </label>
                <input className={inputCls} value={form.lastName} onChange={set('lastName')} />
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className={labelCls}>Country</label>
              <select className={inputCls} value={form.country} onChange={set('country')}>
                {COUNTRIES.map(c => (
                  <option key={c.value} value={c.value}>{c.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelCls}>ABN</label>
              <input
                className={abnInvalid ? `${inputCls} border-brand-red focus:border-brand-red` : inputCls}
                placeholder="11 digits"
                value={form.abn}
                onChange={set('abn')}
                aria-invalid={abnInvalid}
              />
              {abnInvalid && <p className="m-0 mt-1 text-[11px] text-brand-red">Invalid Australian ABN — check the 11 digits.</p>}
            </div>
            <div>
              <label className={labelCls}>GST Status</label>
              <select className={inputCls} value={form.gstStatus} onChange={set('gstStatus')}>
                {Object.values(GST_STATUS).map(s => (
                  <option key={s} value={s}>{GST_STATUS_LABELS[s]}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className={labelCls}>Email</label>
              <input type="email" className={inputCls} placeholder="accounts@example.com.au" value={form.email} onChange={set('email')} />
            </div>
            <div>
              <label className={labelCls}>Phone</label>
              <input className={inputCls} placeholder="e.g. 02 9000 0000" value={form.phone} onChange={set('phone')} />
            </div>
          </div>

          <div>
            <label className={labelCls}>Address</label>
            <div className="grid grid-cols-2 sm:grid-cols-[2fr_1fr_1fr_1fr] gap-2">
              <input className={inputCls} placeholder="Street" value={form.street} onChange={set('street')} />
              <input className={inputCls} placeholder="Suburb" value={form.suburb} onChange={set('suburb')} />
              <input className={inputCls} placeholder="State" value={form.state} onChange={set('state')} />
              <input className={inputCls} placeholder="Postcode" value={form.postcode} onChange={set('postcode')} />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className={labelCls}>Trades / Categories</label>
              <input className={inputCls} placeholder="e.g. Concrete, Formwork" value={form.trades} onChange={set('trades')} />
            </div>
            <div>
              <label className={labelCls}>Payment Terms (days)</label>
              <input type="number" min="0" step="1" className={inputCls} placeholder="e.g. 30" value={form.paymentDays} onChange={set('paymentDays')} />
            </div>
            <div>
              <label className={labelCls}>Terms Basis</label>
              <select className={inputCls} value={form.paymentBasis} onChange={set('paymentBasis')}>
                {Object.values(PAYMENT_TERMS_BASIS).map(b => (
                  <option key={b} value={b}>{PAYMENT_TERMS_BASIS_LABELS[b]}</option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className={labelCls}>Projects</label>
            {projectsLoading ? (
              <p className="m-0 text-[12px] text-brand-muted">Loading projects…</p>
            ) : projects.length === 0 && unknownAssignments.length === 0 ? (
              <p className="m-0 text-[12px] text-brand-muted">No projects yet — create a project to assign contacts to it.</p>
            ) : (
              <div className="flex flex-wrap gap-x-3 gap-y-1.5 pt-1.5">
                {projects.map(project => {
                  const assigned = isAssignedInForm(project.id)
                  const locked   = isArchived && !assigned
                  return (
                    <label
                      key={project.id}
                      className={`flex items-center gap-1.5 text-[13px] min-h-[24px] ${locked ? 'text-brand-muted cursor-not-allowed' : 'text-brand-text cursor-pointer'}`}
                    >
                      <input
                        type="checkbox"
                        checked={assigned}
                        onChange={toggleProject(project.id)}
                        disabled={locked}
                        className="accent-[#00C9A7]"
                      />
                      {project.name}
                    </label>
                  )
                })}
                {unknownAssignments.map(a => (
                  <label key={a.projectId} className="flex items-center gap-1.5 text-[13px] text-brand-muted min-h-[24px] cursor-pointer">
                    <input type="checkbox" checked onChange={toggleProject(a.projectId)} className="accent-[#00C9A7]" />
                    Unknown project
                  </label>
                ))}
              </div>
            )}
            {isArchived && (
              <p className="m-0 mt-1 text-[11px] text-brand-muted">Archived contacts can't be assigned to new projects — reactivate first.</p>
            )}
          </div>

          {isOrg && (
            <div>
              <label className={labelCls}>Contact People</label>
              {form.people.length === 0 && (
                <p className="m-0 mb-2 text-[12px] text-brand-muted">No contact people yet.</p>
              )}
              <div className="flex flex-col gap-2">
                {form.people.map(person => (
                  <div key={person.id} className="grid grid-cols-2 sm:grid-cols-[auto_2fr_2fr_2fr_2fr_2fr_auto] gap-2 items-center">
                    <label
                      className="flex items-center justify-center min-w-[32px] min-h-[44px] cursor-pointer"
                      title="Primary contact"
                    >
                      <input
                        type="radio"
                        name="primaryPerson"
                        checked={form.primaryPersonId === person.id}
                        onChange={setPrimary(person.id)}
                        onClick={form.primaryPersonId === person.id ? setPrimary(person.id) : undefined}
                        className="accent-[#00C9A7]"
                      />
                    </label>
                    <input className={inputCls} placeholder="Name" value={person.name} onChange={setPerson(person.id, 'name')} />
                    <input className={inputCls} placeholder="Job title" value={person.jobTitle} onChange={setPerson(person.id, 'jobTitle')} />
                    <input type="email" className={inputCls} placeholder="Email" value={person.email} onChange={setPerson(person.id, 'email')} />
                    <input className={inputCls} placeholder="Phone" value={person.phone} onChange={setPerson(person.id, 'phone')} />
                    <input className={inputCls} placeholder="Notes" value={person.notes} onChange={setPerson(person.id, 'notes')} />
                    <button
                      type="button"
                      onClick={() => removePerson(person.id)}
                      aria-label="Remove person"
                      className="text-brand-muted hover:text-brand-red text-lg leading-none cursor-pointer min-w-[44px] min-h-[44px] flex items-center justify-center"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
              <div className="mt-2 flex items-center gap-3">
                <Btn variant="ghost" type="button" sm onClick={addPerson}>+ Add person</Btn>
                {form.people.length > 0 && (
                  <p className="m-0 text-[11px] text-brand-muted">Select the radio button to mark the primary contact. Unnamed people are dropped on save.</p>
                )}
              </div>
            </div>
          )}

          <div>
            <label className={labelCls}>Notes</label>
            <input className={inputCls} placeholder="Optional" value={form.notes} onChange={set('notes')} />
          </div>

          {warnings.length > 0 && (
            <div className="border border-brand-amber/25 bg-brand-amber/10 rounded-lg px-3 py-2">
              <p className="m-0 text-[11px] font-bold text-brand-amber uppercase tracking-[0.4px]">Possible duplicates</p>
              {warnings.map((w, i) => (
                <p key={i} className="m-0 mt-1 text-[12px] text-brand-amber">{w.message}</p>
              ))}
              <p className="m-0 mt-1 text-[11px] text-brand-muted">You can still save — check it isn't the same contact first.</p>
            </div>
          )}

          {validationError && (
            <p className="m-0 text-[12px] text-brand-red">{validationError}</p>
          )}
          {error && <p className="m-0 text-[12px] text-brand-red">{error}</p>}

          <div className="flex justify-end gap-2 pt-1 border-t border-brand-border">
            <Btn variant="ghost" type="button" onClick={onClose} sm disabled={saving}>Cancel</Btn>
            <Btn type="submit" sm disabled={saving || !!validationError}>
              {saving ? 'Saving…' : isEdit ? 'Save Changes' : 'Create Contact'}
            </Btn>
          </div>
        </form>
      </div>
    </div>
  )
}

const matchesSearch = (contact, term) => {
  const haystack = [
    contact.displayName, contact.legalName, contact.tradingName,
    contact.abn, contact.email, contact.phone,
    ...(contact.trades ?? []),
    ...(contact.people ?? []).flatMap(p => [p.name, p.email]),
  ].filter(Boolean).join(' ').toLowerCase()
  return haystack.includes(term)
}

export default function Contacts() {
  const { contacts, contactsLoading, createContact, updateContact, archiveContact, reactivateContact } = useContacts()
  const { projects, projectsLoading } = useProjects()
  const [search, setSearch]           = useState('')
  const [typeFilter, setTypeFilter]   = useState('all')
  const [statusFilter, setStatusFilter] = useState('active')
  const [projectFilter, setProjectFilter] = useState('all')
  const [showCreate, setShowCreate]   = useState(false)
  const [editing, setEditing]         = useState(null)
  const [actionError, setActionError] = useState(null)

  const term = search.trim().toLowerCase()
  const matchesProject = (c) =>
    projectFilter === 'all' ||
    (projectFilter === 'unassigned'
      ? (c.projectIds ?? []).length === 0
      : (c.projectIds ?? []).includes(projectFilter))
  const filtered = contacts.filter(c =>
    (statusFilter === 'all' || (statusFilter === 'active' ? c.isActive !== false : c.isActive === false)) &&
    (typeFilter === 'all' || (c.contactTypes ?? []).includes(typeFilter)) &&
    matchesProject(c) &&
    (!term || matchesSearch(c, term))
  )

  const projectNameById = new Map(projects.map(p => [p.id, p.name]))
  const assignedProjectNames = (contact) =>
    (contact.projectIds ?? []).map(id => projectNameById.get(id) ?? 'Unknown project')

  const primaryPerson = (contact) =>
    (contact.people ?? []).find(p => p.id === contact.primaryPersonId) ?? null

  async function handleArchiveToggle(contact) {
    const archiving = contact.isActive !== false
    if (!window.confirm(`${archiving ? 'Archive' : 'Reactivate'} ${contact.displayName}?`)) return
    setActionError(null)
    try {
      await (archiving ? archiveContact(contact) : reactivateContact(contact))
    } catch {
      setActionError('Failed to update contact. Check your connection and try again.')
    }
  }

  return (
    <div>
      <PageHeader title="Contacts" sub="Suppliers, subcontractors, consultants, and clients — company-wide">
        <Btn sm onClick={() => setShowCreate(true)}>+ New Contact</Btn>
      </PageHeader>

      <div className="flex flex-col sm:flex-row gap-2 mb-3.5">
        <input
          className={`${inputCls} sm:max-w-[280px]`}
          placeholder="Search name, ABN, email, people…"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        <select className={`${inputCls} sm:max-w-[180px]`} value={typeFilter} onChange={e => setTypeFilter(e.target.value)}>
          <option value="all">All types</option>
          {CONTACT_TYPES.map(t => (
            <option key={t} value={t}>{CONTACT_TYPE_LABELS[t]}</option>
          ))}
        </select>
        <select className={`${inputCls} sm:max-w-[180px]`} value={projectFilter} onChange={e => setProjectFilter(e.target.value)}>
          <option value="all">All projects</option>
          <option value="unassigned">Unassigned</option>
          {projects.map(p => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
        <select className={`${inputCls} sm:max-w-[150px]`} value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
          <option value="active">Active</option>
          <option value="archived">Archived</option>
          <option value="all">All</option>
        </select>
      </div>

      {actionError && <p className="text-[12px] text-brand-red mb-3">{actionError}</p>}

      <Card padding={false}>
        {contactsLoading ? (
          <div className="px-5 py-12 text-center text-[13px] text-brand-muted">Loading contacts…</div>
        ) : filtered.length === 0 ? (
          <div className="px-5 py-12 text-center">
            <p className="text-[13px] text-brand-muted mb-3">
              {contacts.length === 0
                ? 'No contacts yet. Add your suppliers, subcontractors, consultants, and clients.'
                : 'No contacts match the current search or filters.'}
            </p>
            {contacts.length === 0 && (
              <Btn onClick={() => setShowCreate(true)}>+ Create your first contact</Btn>
            )}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr className="bg-brand-card border-b border-brand-border">
                  {['Name', 'Types', 'Projects', 'ABN', 'Email', 'Phone', 'Primary Contact', 'Status', ''].map((h, i) => (
                    <th key={i} className={thCls}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map(contact => {
                  const archived = contact.isActive === false
                  const primary  = primaryPerson(contact)
                  return (
                    <tr key={contact.id} className={`border-b border-brand-border hover:bg-brand-card transition-colors ${archived ? 'opacity-60' : ''}`}>
                      <td className="px-3.5 py-3">
                        <p className="m-0 text-[13px] font-semibold text-brand-text">{contact.displayName}</p>
                        {contact.entityType === ENTITY_TYPE.ORGANISATION && contact.legalName && contact.legalName !== contact.displayName && (
                          <p className="m-0 text-[11px] text-brand-muted">{contact.legalName}</p>
                        )}
                      </td>
                      <td className="px-3.5 py-3">
                        <div className="flex flex-wrap gap-1">
                          {(contact.contactTypes ?? []).map(t => (
                            <Badge key={t} label={CONTACT_TYPE_LABELS[t] ?? t} variant={CONTACT_TYPE_BADGE_VARIANTS[t]} sm />
                          ))}
                        </div>
                      </td>
                      <td className="px-3.5 py-3 text-[12px] text-brand-muted">
                        {assignedProjectNames(contact).join(', ') || '—'}
                      </td>
                      <td className="px-3.5 py-3 text-[12px] text-brand-muted whitespace-nowrap">{contact.abn ? formatAbn(contact.abn) : '—'}</td>
                      <td className="px-3.5 py-3 text-[12px] text-brand-muted">{contact.email || '—'}</td>
                      <td className="px-3.5 py-3 text-[12px] text-brand-muted whitespace-nowrap">{contact.phone || '—'}</td>
                      <td className="px-3.5 py-3 text-[12px] text-brand-muted">
                        {primary ? `${primary.name}${primary.jobTitle ? ` — ${primary.jobTitle}` : ''}` : '—'}
                      </td>
                      <td className="px-3.5 py-3">
                        <Badge label={archived ? 'Archived' : 'Active'} variant={archived ? 'soon' : 'active'} sm />
                      </td>
                      <td className="px-3.5 py-3">
                        <div className="flex gap-1.5 justify-end">
                          <Btn sm variant="ghost" onClick={() => setEditing(contact)}>Edit</Btn>
                          <Btn sm variant="ghost" onClick={() => handleArchiveToggle(contact)}>
                            {archived ? 'Reactivate' : 'Archive'}
                          </Btn>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {showCreate && (
        <ContactFormModal
          contact={null}
          contacts={contacts}
          projects={projects}
          projectsLoading={projectsLoading}
          onClose={() => setShowCreate(false)}
          onSave={createContact}
        />
      )}
      {editing && (
        <ContactFormModal
          contact={editing}
          contacts={contacts}
          projects={projects}
          projectsLoading={projectsLoading}
          onClose={() => setEditing(null)}
          onSave={(data) => updateContact(editing, data)}
        />
      )}
    </div>
  )
}
