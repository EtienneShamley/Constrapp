// Shared Tailwind class strings for the Documents & Drawings views.
//
// The existing project pages each declare these locally, which is fine when the
// pages are far apart. This feature ships seven files in ONE folder that render
// the same form controls and the same register tables, so the strings live once
// here rather than being copied seven times. The values are IDENTICAL to the
// ones in ProjectClientReceipts.jsx / ProjectSupplierPayments.jsx — this is not
// a new visual language, it is the existing one, deduplicated.
export const inputCls = 'w-full bg-brand-bg border border-brand-border rounded-lg px-3 py-2 text-[13px] text-brand-text placeholder:text-brand-muted focus:border-brand-accent focus:outline-none'
export const labelCls = 'block text-[11px] font-bold text-brand-muted uppercase tracking-[0.4px] mb-1.5'
export const thCls    = 'text-left px-3.5 py-[10px] text-brand-muted text-[11px] font-bold uppercase tracking-[0.4px]'

// Modal chrome, likewise identical to the existing pages'.
export const modalShellCls = 'fixed inset-0 z-50 flex items-center justify-center p-4'
export const modalCardCls  = 'relative z-10 w-full bg-brand-surface border border-brand-border rounded-xl shadow-2xl max-h-[90vh] overflow-y-auto'
