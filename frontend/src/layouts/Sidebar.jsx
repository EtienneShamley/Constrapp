import { NavLink } from 'react-router-dom'
import { NAV } from '../lib/nav'

const Logo = () => (
  <svg width="32" height="32" viewBox="0 0 40 40" fill="none">
    <path d="M28 8L16 20L28 32" stroke="#00C9A7" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M20 8L8 20L20 32" stroke="#00C9A7" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" opacity="0.45" />
  </svg>
)

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

      <aside
        className={`
          fixed top-0 left-0 h-full w-[222px] bg-brand-sidebar border-r border-brand-border z-30 flex flex-col
          transition-transform duration-200
          ${open ? 'translate-x-0' : '-translate-x-full'}
          md:translate-x-0 md:static md:flex
        `}
      >
        {/* Logo */}
        <div className="flex items-center gap-2.5 px-4 border-b border-brand-border shrink-0" style={{ height: 56 }}>
          <Logo />
          <span className="text-[17px] font-black text-brand-text tracking-tight">Constrapp</span>
        </div>

        {/* Company switcher — static placeholder */}
        <div className="px-3 py-2.5 border-b border-brand-border shrink-0">
          <div className="flex items-center gap-2 bg-brand-bg border border-brand-border rounded-lg px-2.5 py-[7px] cursor-default select-none">
            <div className="w-2 h-2 rounded-full bg-brand-accent shrink-0" />
            <span className="text-brand-text text-[11px] font-semibold flex-1 truncate">Apex Builders</span>
            <span className="text-brand-muted text-[9px]">▼</span>
          </div>
        </div>

        {/* Nav */}
        <nav className="flex-1 overflow-y-auto py-2 px-2">
          {NAV.map(({ to, label, icon, end, pulse, shield }) => {
            const activeAccent = pulse ? '#FF6B9D' : shield ? '#00D4FF' : '#00C9A7'
            const activeBg     = pulse ? 'rgba(255,107,157,0.1)' : shield ? 'rgba(0,212,255,0.1)' : 'rgba(0,201,167,0.08)'

            return (
              <NavLink
                key={to}
                to={to}
                end={end}
                onClick={onClose}
                className={({ isActive }) =>
                  `flex items-center gap-2.5 px-2.5 py-2 rounded-lg mb-0.5 text-[12.5px] min-h-[40px] border-l-[3px] transition-all duration-100
                   ${isActive ? 'font-bold' : 'border-transparent text-brand-muted hover:bg-brand-surface'}`
                }
                style={({ isActive }) => ({
                  borderLeftColor: isActive ? activeAccent : 'transparent',
                  background:      isActive ? activeBg : undefined,
                  color:           isActive ? activeAccent : undefined,
                })}
              >
                <span className="text-[14px] w-5 text-center shrink-0">{icon}</span>
                <span className="flex-1 leading-none">{label}</span>
                {pulse && (
                  <span
                    className="w-1.5 h-1.5 rounded-full shrink-0"
                    style={{ background: '#FF6B9D', animation: 'pulse-dot 1s ease-in-out infinite' }}
                  />
                )}
                {shield && (
                  <span
                    className="w-1.5 h-1.5 rounded-full shrink-0"
                    style={{ background: '#00D4FF', animation: 'pulse-dot 1.4s ease-in-out infinite' }}
                  />
                )}
              </NavLink>
            )
          })}
        </nav>

        {/* Footer */}
        <div className="px-3.5 py-3 border-t border-brand-border shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-full bg-brand-accent/10 border-2 border-brand-accent/40 flex items-center justify-center text-[11px] font-black text-brand-accent shrink-0">
              ES
            </div>
            <div className="min-w-0">
              <p className="text-[11px] font-bold text-brand-text truncate leading-tight">Etienne S</p>
              <p className="text-[9px] text-brand-accent leading-tight mt-0.5">Company Admin</p>
            </div>
          </div>
        </div>
      </aside>
    </>
  )
}
