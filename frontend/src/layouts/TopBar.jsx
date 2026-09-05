import { useEffect, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { NAV } from '../lib/nav'
import { useAuth, getInitials, getDisplayName } from '../hooks/useAuth'
import { useProfile } from '../hooks/useProfile'
import { useCompany } from '../hooks/useCompany'

function resolveLabel(pathname) {
  const exact = NAV.find(n => pathname === n.to)
  if (exact) return exact.label
  const prefix = NAV.filter(n => !n.end && n.to !== '/').find(n => pathname.startsWith(n.to + '/'))
  return prefix?.label ?? 'Dashboard'
}

export default function TopBar({ onMenuClick }) {
  const { pathname }      = useLocation()
  const { user, signOut } = useAuth()
  const { profile }       = useProfile()
  const { company }       = useCompany()
  const pageLabel         = resolveLabel(pathname)

  // Prefer Firestore profile name; fall back to Auth-derived value
  const displayName = profile?.name || getDisplayName(user)
  const initials    = profile?.avatarInitials || getInitials(user)
  const companyName = company?.name ?? null

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

      {/* Right: user menu.
          ⚠️ A decorative SEARCH box (readOnly, tabIndex -1) and a NOTIFICATION
          BELL carrying a permanent red unread dot used to sit here. Neither had
          a handler: the search could not be typed into and the dot asserted
          unread notifications that cannot exist, because notifications are not
          a feature. Both are removed rather than disabled — an affordance that
          looks live and does nothing is worse than an absent one. Re-add them
          with the features, not before. */}
      <div className="flex items-center gap-3">
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
              {companyName && (
                <p className="text-[9px] text-brand-muted m-0 mt-0.5 leading-none truncate max-w-[80px]">{companyName}</p>
              )}
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
                {companyName && (
                  <div className="mt-2.5 flex items-center gap-1.5 bg-brand-bg border border-brand-border rounded-md px-2 py-[5px]">
                    <div className="w-1.5 h-1.5 rounded-full bg-brand-accent shrink-0" />
                    <span className="text-[10px] text-brand-text font-medium truncate">{companyName}</span>
                  </div>
                )}
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
