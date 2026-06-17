export default function TopBar({ onMenuClick }) {
  return (
    <header className="h-16 bg-brand-sidebar border-b border-brand-border flex items-center px-4 gap-4 shrink-0">
      <button
        className="md:hidden text-brand-muted hover:text-brand-text min-w-[44px] min-h-[44px] flex items-center justify-center"
        onClick={onMenuClick}
        aria-label="Open menu"
      >
        ☰
      </button>

      <div className="flex-1" />

      <div className="flex items-center gap-3 text-sm text-brand-muted">
        <span className="hidden sm:block">FY2025–26</span>
        <div className="w-2 h-2 rounded-full bg-brand-accent" title="Live" />
      </div>
    </header>
  )
}
