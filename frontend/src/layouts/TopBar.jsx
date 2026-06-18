import { useLocation } from 'react-router-dom'
import { NAV } from '../lib/nav'

function resolveLabel(pathname) {
  // Exact match first, then prefix match for nested routes
  const exact = NAV.find(n => pathname === n.to)
  if (exact) return exact.label
  const prefix = NAV.filter(n => !n.end && n.to !== '/').find(n => pathname.startsWith(n.to + '/'))
  return prefix?.label ?? 'Dashboard'
}

export default function TopBar({ onMenuClick }) {
  const { pathname } = useLocation()
  const pageLabel = resolveLabel(pathname)

  return (
    <header
      className="bg-brand-sidebar border-b border-brand-border flex items-center justify-between px-6 shrink-0"
      style={{ height: 56 }}
    >
      {/* Left: mobile hamburger + page title */}
      <div className="flex items-center gap-3">
        <button
          className="md:hidden text-brand-muted hover:text-brand-text min-w-[44px] min-h-[44px] flex items-center justify-center"
          onClick={onMenuClick}
          aria-label="Open menu"
        >
          ☰
        </button>
        <div className="flex items-center gap-3">
          <div className="hidden md:block w-1 h-[18px] bg-brand-accent rounded-full" />
          <h1 className="text-[15px] font-extrabold text-brand-text m-0 leading-none">{pageLabel}</h1>
        </div>
      </div>

      {/* Right: search · notifications · user pill */}
      <div className="flex items-center gap-3">
        {/* Search — decorative */}
        <div className="hidden sm:flex items-center gap-2 bg-brand-bg border border-brand-border rounded-lg px-3 py-[6px]">
          <span className="text-brand-muted text-[13px] leading-none">🔍</span>
          <input
            className="bg-transparent border-none outline-none text-brand-text text-[12.5px] w-[130px] placeholder:text-brand-muted"
            placeholder="Search…"
            readOnly
            tabIndex={-1}
          />
        </div>

        {/* Notification bell */}
        <div className="relative w-9 h-9 bg-brand-bg border border-brand-border rounded-lg flex items-center justify-center cursor-default select-none shrink-0">
          <span className="text-base leading-none">🔔</span>
          <div className="absolute top-[6px] right-[6px] w-2 h-2 bg-brand-red rounded-full border-2 border-brand-sidebar" />
        </div>

        {/* User pill */}
        <div className="flex items-center gap-2 bg-brand-bg border border-brand-border rounded-[20px] pl-1 pr-2.5 py-1 select-none">
          <div className="w-7 h-7 rounded-full bg-brand-accent/10 border-2 border-brand-accent/40 flex items-center justify-center text-[10px] font-black text-brand-accent shrink-0">
            ES
          </div>
          <div className="hidden sm:block leading-tight">
            <p className="text-[11px] font-bold text-brand-text m-0 leading-none">Etienne S</p>
            <p className="text-[9px] text-brand-muted m-0 mt-0.5 leading-none">Apex Builders</p>
          </div>
          <div className="w-6 h-6 rounded-md bg-brand-surface border border-brand-border flex items-center justify-center cursor-default text-[11px] text-brand-muted ml-1">
            ↩
          </div>
        </div>
      </div>
    </header>
  )
}
