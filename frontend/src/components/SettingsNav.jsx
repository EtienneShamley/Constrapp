import { NavLink } from 'react-router-dom'

// Two-item sub-navigation shared by the Company Settings pages (ADR-72):
// Company (country & currency) and Team (members & invitations). Project
// navigation is untouched.
const SECTIONS = [
  { to: '/settings/company', label: 'Company' },
  { to: '/settings/team',    label: 'Team' },
]

export default function SettingsNav() {
  return (
    <nav aria-label="Company settings sections" className="flex flex-wrap gap-2 mb-5">
      {SECTIONS.map(s => (
        <NavLink
          key={s.to}
          to={s.to}
          className={({ isActive }) =>
            `inline-flex items-center min-h-[44px] px-4 rounded-lg text-[12.5px] font-bold border transition-colors ` +
            (isActive
              ? 'bg-brand-accent/10 text-brand-accent border-brand-accent/25'
              : 'bg-transparent text-brand-muted border-brand-border hover:text-brand-text hover:bg-brand-surface')
          }
        >
          {s.label}
        </NavLink>
      ))}
    </nav>
  )
}
