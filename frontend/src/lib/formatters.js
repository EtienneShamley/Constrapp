export const formatDate = (ts) => {
  if (!ts) return '—'
  return ts.toDate().toLocaleDateString('en-AU', { day: '2-digit', month: '2-digit', year: 'numeric' })
}

const aud = new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD', maximumFractionDigits: 0 })
const pct = new Intl.NumberFormat('en-AU', { style: 'percent', maximumFractionDigits: 1 })

export const currency = (n) => aud.format(n)
export const percent  = (n) => pct.format(n / 100)

const ROLE_LABELS = {
  super_admin:     'Super Admin',
  company_admin:   'Company Admin',
  project_manager: 'Project Manager',
  qs:              'QS / Office',
  subcontractor:   'Subcontractor',
  client:          'Client',
}

export const formatRole = (role) => ROLE_LABELS[role] ?? role ?? '—'
