import { NavLink, Outlet, useOutletContext } from 'react-router-dom'

// The Commercial tab is the project's REVENUE-AND-CASH workspace. It hosts the
// Project Margin view (index), the Client Invoices / Accounts Receivable
// register, the Client Receipts register (money actually received), and the
// Supplier Payments register (money actually paid). BOTH cash directions belong
// on one tab because Cash Flow — the remaining branch — must read them together.
//
// Sub-navigation rather than a new project tab: the tab bar already carries
// fourteen tabs and wraps on mobile, and these views share one audience
// (financial roles) and one subject (contract revenue and the cash moving
// against it).
//
// NOTE: `receipts` keeps its original ROUTE while its LABEL reads "Client
// Receipts" — the route is shareable and already in use, and only the label
// needed disambiguating once Supplier Payments joined it.
//
// The parent project context is forwarded unchanged, so the views below read
// the SAME { project, projectId, currencyCode } every other project tab reads —
// no page resolves a currency for itself.
const SUB_TABS = [
  { to: '.',                 label: 'Margin',            end: true },
  { to: 'client-invoices',   label: 'Client Invoices',   end: false },
  { to: 'receipts',          label: 'Client Receipts',   end: false },
  { to: 'supplier-payments', label: 'Supplier Payments', end: false },
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
