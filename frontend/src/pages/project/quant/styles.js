// Shared Tailwind class strings for the Quant™ takeoff workspace — the same
// values the Documents & Drawings and BOQ views declare, deduplicated once for
// the seven files in this folder. Not a new visual language.
export const inputCls = 'w-full bg-brand-bg border border-brand-border rounded-lg px-3 py-2 min-h-[44px] text-[13px] text-brand-text placeholder:text-brand-muted focus:border-brand-accent focus:outline-none'
export const labelCls = 'block text-[11px] font-bold text-brand-muted uppercase tracking-[0.4px] mb-1.5'
export const thCls    = 'text-left px-3 py-[10px] text-brand-muted text-[11px] font-bold uppercase tracking-[0.4px] whitespace-nowrap'
export const tdCls    = 'px-3 py-3 text-[13px] text-brand-text align-top'

export const modalShellCls = 'fixed inset-0 z-50 flex items-center justify-center p-4'
export const modalCardCls  = 'relative z-10 w-full bg-brand-surface border border-brand-border rounded-xl shadow-2xl max-h-[90vh] overflow-y-auto'

// A toolbar button: a real <button>, 44px target, pressed state in the Quant
// token so the active tool is visible without relying on colour alone (the
// label text and aria-pressed carry the meaning).
export const toolBtnCls = (active) =>
  `inline-flex min-h-[44px] items-center gap-1.5 rounded-lg border px-3 text-[12px] font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-brand-accent disabled:opacity-50 disabled:cursor-not-allowed ${
    active ? 'border-brand-quant/40 bg-brand-quant/15 text-brand-text' : 'border-brand-border text-brand-muted hover:text-brand-text hover:bg-brand-card'
  }`
