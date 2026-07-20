import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import PageHeader from '../components/PageHeader'
import Card from '../components/Card'
import Btn from '../components/Btn'
import Badge from '../components/Badge'
import { useContacts } from '../hooks/useContacts'
import { CONTACT_TYPE, formatAbn } from '../lib/contacts'

const inputCls = 'w-full bg-brand-bg border border-brand-border rounded-lg px-3 py-2 text-[13px] text-brand-text placeholder:text-brand-muted focus:border-brand-accent focus:outline-none'
const thCls    = 'text-left px-3.5 py-[10px] text-brand-muted text-[11px] font-bold uppercase tracking-[0.4px]'

// Filtered view of the company-wide Contacts collection — subcontractors are
// contacts, not a separate collection. Records are managed on /contacts.
export default function Subcontractors() {
  const navigate = useNavigate()
  const { contacts, contactsLoading } = useContacts()
  const [search, setSearch] = useState('')

  const term = search.trim().toLowerCase()
  const subcontractors = contacts.filter(c =>
    c.isActive !== false &&
    (c.contactTypes ?? []).includes(CONTACT_TYPE.SUBCONTRACTOR) &&
    (!term || [
      c.displayName, c.legalName, c.abn, c.email, c.phone,
      ...(c.trades ?? []),
      ...(c.people ?? []).flatMap(p => [p.name, p.email]),
    ].filter(Boolean).join(' ').toLowerCase().includes(term))
  )

  const primaryPerson = (contact) =>
    (contact.people ?? []).find(p => p.id === contact.primaryPersonId) ?? null

  return (
    <div>
      <PageHeader title="Subcontractors" sub="Active subcontractors from your company contacts">
        <Btn sm variant="ghost" onClick={() => navigate('/contacts')}>Manage in Contacts</Btn>
      </PageHeader>

      <div className="mb-3.5">
        <input
          className={`${inputCls} sm:max-w-[280px]`}
          placeholder="Search subcontractors…"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
      </div>

      <Card padding={false} className="mb-4">
        {contactsLoading ? (
          <div className="px-5 py-12 text-center text-[13px] text-brand-muted">Loading subcontractors…</div>
        ) : subcontractors.length === 0 ? (
          <div className="px-5 py-12 text-center">
            <p className="text-[13px] text-brand-muted mb-3">
              {term
                ? 'No subcontractors match the current search.'
                : 'No subcontractors yet. Add contacts with the Subcontractor type.'}
            </p>
            {!term && (
              <Btn variant="ghost" onClick={() => navigate('/contacts')}>Go to Contacts</Btn>
            )}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr className="bg-brand-card border-b border-brand-border">
                  {['Name', 'Trades', 'ABN', 'Primary Contact', 'Email', 'Phone'].map((h, i) => (
                    <th key={i} className={thCls}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {subcontractors.map(contact => {
                  const primary = primaryPerson(contact)
                  return (
                    <tr key={contact.id} className="border-b border-brand-border hover:bg-brand-card transition-colors">
                      <td className="px-3.5 py-3">
                        <p className="m-0 text-[13px] font-semibold text-brand-text">{contact.displayName}</p>
                        {contact.legalName && contact.legalName !== contact.displayName && (
                          <p className="m-0 text-[11px] text-brand-muted">{contact.legalName}</p>
                        )}
                      </td>
                      <td className="px-3.5 py-3 text-[12px] text-brand-muted">{(contact.trades ?? []).join(', ') || '—'}</td>
                      <td className="px-3.5 py-3 text-[12px] text-brand-muted whitespace-nowrap">{contact.abn ? formatAbn(contact.abn) : '—'}</td>
                      <td className="px-3.5 py-3 text-[12px] text-brand-muted">
                        {primary ? `${primary.name}${primary.jobTitle ? ` — ${primary.jobTitle}` : ''}` : '—'}
                      </td>
                      <td className="px-3.5 py-3 text-[12px] text-brand-muted">{contact.email || '—'}</td>
                      <td className="px-3.5 py-3 text-[12px] text-brand-muted whitespace-nowrap">{contact.phone || '—'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card>
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm font-medium text-brand-text">Constrapp IQ™</span>
          <Badge label="Coming Soon" variant="soon" />
        </div>
        <p className="text-sm text-brand-muted">
          Coming in a later sprint — AI-powered subcontractor accountability scoring, schedule analysis, and variation intelligence are planned for Sprint 5.
        </p>
      </Card>
    </div>
  )
}
