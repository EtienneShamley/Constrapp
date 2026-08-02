import { NavLink, Outlet, useOutletContext } from 'react-router-dom'

// The Commercial tab is the project's REVENUE-side workspace. It hosts the
// Project Margin view (index) and the Client Invoices / Accounts Receivable
// register, and is where Payments & Receipts and Cash Flow will land.
//
// Sub-navigation rather than a new project tab: the tab bar already carries
// fourteen tabs and wraps on mobile, and these views share one audience
// (financial roles) and one subject (contract revenue).
//
// The parent project context is forwarded unchanged, so the views below read
// the SAME { project, projectId, currencyCode } every other project tab reads —
// no page resolves a currency for itself.
const SUB_TABS = [
  { to: '.',               label: 'Margin',          end: true },
  { to: 'client-invoices', label: 'Client Invoices', end: false },
]

export default function ProjectCommercialLayout() {
  const context = useOutletContext()

  return (
    <div>
      <nav className="flex flex-wrap gap-1.5 mb-4">
        {SUB_TABS.map(({ to, label, end }) => (
          <NavLink
            key={label}
            to={to}
            end={end}
            className={({ isActive }) =>
              `px-3 py-2 min-h-[44px] flex items-center text-[12.5px] font-semibold rounded-lg border transition-colors
               ${isActive
                 ? 'bg-brand-accent/15 text-brand-accent border-brand-accent/25'
                 : 'text-brand-muted border-brand-border hover:text-brand-text'}`
            }
          >
            {label}
          </NavLink>
        ))}
      </nav>

      <Outlet context={context} />
    </div>
  )
}
