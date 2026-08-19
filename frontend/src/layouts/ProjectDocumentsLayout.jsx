import { NavLink, Outlet, useOutletContext } from 'react-router-dom'

// The Documents tab is the project's DOCUMENT CONTROL workspace: the Drawings
// register (index, with a detail route per drawing) and the General Documents
// register.
//
// Sub-navigation rather than a fifteenth project tab — the tab bar already
// wraps on mobile, and both views share one subject (controlled project files)
// even though they have different audiences and different write roles.
//
// The parent project context is forwarded unchanged, so these views read the
// SAME { project, projectId, currencyCode } every other project tab reads.
const SUB_TABS = [
  { to: '.',        label: 'Drawings',          end: true },
  { to: 'general',  label: 'General Documents', end: false },
]

export default function ProjectDocumentsLayout() {
  const context = useOutletContext()

  return (
    <div>
      {/* Below sm: a horizontally-scrolling strip (no wrapping, full labels);
          from sm: up, normal wrapping. Touch targets stay ≥44px in both. */}
      <nav className="flex gap-1.5 mb-4 overflow-x-auto sm:overflow-x-visible sm:flex-wrap">
        {SUB_TABS.map(({ to, label, end }) => (
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
