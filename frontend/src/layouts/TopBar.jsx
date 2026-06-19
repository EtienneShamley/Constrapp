import { useEffect, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { NAV } from '../lib/nav'
import { useAuth, getInitials, getDisplayName } from '../hooks/useAuth'

function resolveLabel(pathname) {
  const exact = NAV.find(n => pathname === n.to)
  if (exact) return exact.label
  const prefix = NAV.filter(n => !n.end && n.to !== '/').find(n => pathname.startsWith(n.to + '/'))
  return prefix?.label ?? 'Dashboard'
}

export default function TopBar({ onMenuClick }) {
  const { pathname }       = useLocation()
  const { user, signOut }  = useAuth()
  const pageLabel          = resolveLabel(pathname)
  const initials           = getInitials(user)
  const displayName        = getDisplayName(user)

  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef                 = useRef(null)

  useEffect(() => {
    if (!menuOpen) return
    function onOutsideClick(e) {
      if (menuRef.current && !menuRef.current.contains(e.target)) {
        setMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', onOutsideClick)
    return () => document.removeEventListener('mousedown', onOutsideClick)
  }, [menuOpen])

  async function handleSignOut() {
    setMenuOpen(false)
    try {
      await signOut()
    } catch {
      // sign-out failure is non-fatal
    }
  }

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

      {/* Right: search · notifications · user menu */}
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

        {/* User menu trigger + dropdown */}
        <div className="relative" ref={menuRef}>
          <button
            onClick={() => setMenuOpen(o => !o)}
            aria-label="User menu"
            aria-expanded={menuOpen}
            className={`flex items-center gap-2 bg-brand-bg border rounded-[20px] pl-1 pr-2.5 py-1 select-none transition-colors cursor-pointer
              ${menuOpen ? 'border-brand-accent/50' : 'border-brand-border hover:border-brand-accent/40'}`}
          >
            <div className="w-7 h-7 rounded-full bg-brand-accent/10 border-2 border-brand-accent/40 flex items-center justify-center text-[10px] font-black text-brand-accent shrink-0">
              {initials}
            </div>
            <div className="hidden sm:block leading-tight text-left">
              <p className="text-[11px] font-bold text-brand-text m-0 leading-none truncate max-w-[80px]">{displayName}</p>
              <p className="text-[9px] text-brand-muted m-0 mt-0.5 leading-none">Apex Builders</p>
            </div>
            <span
              className="text-brand-muted text-[9px] ml-0.5 transition-transform duration-150 inline-block"
              style={{ transform: menuOpen ? 'rotate(180deg)' : 'rotate(0deg)' }}
            >
              ▾
            </span>
          </button>

          {/* Dropdown panel */}
          {menuOpen && (
            <div className="absolute right-0 top-[calc(100%+6px)] w-56 bg-brand-surface border border-brand-border rounded-xl shadow-lg z-50 overflow-hidden">
              {/* User info */}
              <div className="px-4 py-3.5 border-b border-brand-border">
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-full bg-brand-accent/10 border-2 border-brand-accent/40 flex items-center justify-center text-[13px] font-black text-brand-accent shrink-0">
                    {initials}
                  </div>
                  <div className="min-w-0">
                    <p className="text-[12px] font-bold text-brand-text truncate leading-tight">{displayName}</p>
                    <p className="text-[10px] text-brand-muted truncate leading-tight mt-0.5">{user?.email}</p>
                  </div>
                </div>
                <div className="mt-2.5 flex items-center gap-1.5 bg-brand-bg border border-brand-border rounded-md px-2 py-[5px]">
                  <div className="w-1.5 h-1.5 rounded-full bg-brand-accent shrink-0" />
                  <span className="text-[10px] text-brand-text font-medium truncate">Apex Builders</span>
                </div>
              </div>

              {/* Actions */}
              <div className="py-1">
                <button
                  onClick={handleSignOut}
                  className="w-full flex items-center gap-2.5 px-4 py-2.5 text-[12px] text-brand-muted hover:text-brand-red hover:bg-brand-card transition-colors cursor-pointer text-left min-h-[44px]"
                >
                  <span className="text-[13px] leading-none">↩</span>
                  Sign out
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </header>
  )
}
