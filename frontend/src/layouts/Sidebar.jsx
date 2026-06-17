import { NavLink, Link } from 'react-router-dom'

const nav = [
  { to: '/',               label: 'Dashboard',        icon: '▦' },
  { to: '/projects',       label: 'Projects',          icon: '⬡' },
  { to: '/budgets',        label: 'Budgets',           icon: '◈' },
  { to: '/contacts',       label: 'Contacts',          icon: '◉' },
  { to: '/purchase-orders',label: 'Purchase Orders',   icon: '◻' },
  { to: '/drawings',       label: 'Drawings',          icon: '◫' },
  { to: '/site-photos',    label: 'Site Photos',       icon: '◷' },
  { to: '/subcontractors', label: 'Subcontractors',    icon: '◈' },
  { to: '/timeline',       label: 'Timeline',          icon: '◑' },
  { to: '/reports',        label: 'Reports',           icon: '◧' },
]

export default function Sidebar({ open, onClose }) {
  return (
    <>
      {/* Mobile overlay */}
      {open && (
        <div
          className="fixed inset-0 bg-black/50 z-20 md:hidden"
          onClick={onClose}
        />
      )}

      <aside className={`
        fixed top-0 left-0 h-full w-60 bg-brand-sidebar border-r border-brand-border z-30 flex flex-col
        transition-transform duration-200
        ${open ? 'translate-x-0' : '-translate-x-full'}
        md:translate-x-0 md:static md:flex
      `}>
        {/* Logo */}
        <div className="h-16 flex items-center px-5 border-b border-brand-border shrink-0">
          <Link to="/" onClick={onClose} className="text-lg font-bold text-brand-text tracking-tight hover:opacity-80 transition-opacity">
            Constr<span className="text-brand-accent">app</span>
          </Link>
        </div>

        {/* Nav */}
        <nav className="flex-1 overflow-y-auto py-4 px-3">
          {nav.map(({ to, label, icon }) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
              onClick={onClose}
              className={({ isActive }) =>
                `flex items-center gap-3 px-3 py-2.5 rounded-lg mb-0.5 text-sm font-medium min-h-[44px] transition-colors
                 ${isActive
                   ? 'bg-brand-accent/10 text-brand-accent'
                   : 'text-brand-muted hover:bg-brand-card hover:text-brand-text'}`
              }
            >
              <span className="text-base w-5 text-center">{icon}</span>
              {label}
            </NavLink>
          ))}
        </nav>

        {/* Footer */}
        <div className="p-4 border-t border-brand-border shrink-0 cursor-default select-none">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-full bg-brand-accent/20 text-brand-accent text-xs font-semibold flex items-center justify-center">
              ES
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-brand-text truncate">Etienne S</p>
              <p className="text-xs text-brand-muted truncate">Company Admin</p>
            </div>
          </div>
        </div>
      </aside>
    </>
  )
}
