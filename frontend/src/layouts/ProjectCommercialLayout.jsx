import { NavLink, Outlet, useOutletContext } from 'react-router-dom'
import { useCompany } from '../hooks/useCompany'
import { clientFinanceActivated, clientFinanceTabs } from '../lib/clientFinanceActivation'

// The Commercial tab is the project's REVENUE-AND-CASH workspace. It hosts the
// Project Margin view (index), the Client Invoices / Accounts Receivable
// register, the Client Receipts register (money actually received), the
// Supplier Payments register (money actually paid), Cash Flow — which reads
// BOTH cash directions together — and the Supplier Retention register. That
// shared read is exactly why both directions live on one tab.
//
// Retention belongs here rather than beside Supplier Invoices because a
// Retention Release changes what is PAYABLE (and therefore the cash picture),
// never what was invoiced or what anything cost.
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
  { to: 'cash-flow',         label: 'Cash Flow',         end: false },
  { to: 'retention',         label: 'Supplier Retention', end: false },
  // ADR-88: retention the CLIENT withholds on client invoices, and its
  // releases — the receivable-side mirror, beside its payable counterpart.
  // `clientFinance`: offered only to a company activated for client credit
  // notes and client retention (lib/clientFinanceActivation.js).
  { to: 'client-retention',  label: 'Client Retention',  end: false, clientFinance: true },
  // L2-B (ADR-77): the last stage of the commercial lifecycle. A sub-tab, not
  // a new project tab — same audience, same subject.
  { to: 'final-account',     label: 'Final Account',     end: false },
]

export default function ProjectCommercialLayout() {
  const context = useOutletContext()
  // UX only — the Rules and the backend are the enforcement. While the company
  // is loading or unreadable it is null, which reads as NOT activated.
  const { company } = useCompany()
  const tabs = clientFinanceTabs(SUB_TABS, clientFinanceActivated(company))

  return (
    <div>
      {/* Five sub-tabs: below sm: a horizontally-scrolling strip (no wrapping,
          full labels, links never shrink); from sm: up, normal wrapping. Touch
          targets stay ≥44px in both modes. */}
      {/* data-print-hide: an approved Final Account prints without the sub-nav
          (the L2-A print rules hide it only while a printable report is shown). */}
      <nav data-print-hide className="flex gap-1.5 mb-4 overflow-x-auto sm:overflow-x-visible sm:flex-wrap">
        {tabs.map(({ to, label, end }) => (
          <NavLink
            key={label}
            to={to}
            end={end}
            className={({ isActive }) =>
              `px-3 py-2 min-h-[44px] flex items-center shrink-0 whitespace-nowrap text-[12.5px] font-semibold rounded-lg border transition-colors
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
