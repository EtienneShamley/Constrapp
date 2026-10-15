// ── Dashboard · KPI card (Dashboard v2, ADR-45) ──────────────────────────────
//
// Presentation only: it renders a label, an already-formatted value and
// supporting lines. It receives text, never a number, so it cannot format,
// round or re-derive anything. The quarter-circle corner tint is the v5
// prototype's Stat motif, rebuilt with tokens and Tailwind classes only (the
// shared `Stat` component still carries inline-style debt — DESIGN_SYSTEM.md).
//
// `tone` colours the VALUE only:
//   default     — brand-text
//   danger      — brand-red (a genuinely negative figure)
//   unavailable — brand-amber, smaller (a failed read; the sub line names it)
//   muted       — brand-muted, smaller (e.g. "Contract value not set")

const VALUE_TONE = {
  default:     'text-[22px] sm:text-[26px] text-brand-text',
  danger:      'text-[22px] sm:text-[26px] text-brand-red',
  unavailable: 'text-[18px] text-brand-amber',
  muted:       'text-[15px] text-brand-muted',
}

export default function KpiCard({ label, value, tone = 'default', children }) {
  return (
    <div className="relative min-w-0 overflow-hidden rounded-xl border border-brand-border bg-brand-surface p-4 sm:p-5">
      <div className="pointer-events-none absolute top-0 right-0 h-[60px] w-[60px] rounded-bl-[60px] bg-brand-accent/5" aria-hidden="true" />
      <p className="m-0 mb-1.5 text-[11px] font-bold uppercase tracking-[0.5px] text-brand-muted">{label}</p>
      <p className={`m-0 font-black leading-tight tabular-nums break-words ${VALUE_TONE[tone] ?? VALUE_TONE.default}`}>{value}</p>
      {children && <div className="mt-2 space-y-1">{children}</div>}
    </div>
  )
}

// A supporting line under a KPI value. `tone` colours the text; the words
// always carry the meaning on their own (never colour alone).
const LINE_TONE = {
  muted:   'text-brand-muted',
  soft:    'text-brand-text-soft',
  danger:  'text-brand-red',
  good:    'text-brand-accent',
  warning: 'text-brand-amber',
}

export function KpiLine({ tone = 'muted', children }) {
  return <p className={`m-0 text-[11.5px] leading-snug ${LINE_TONE[tone] ?? LINE_TONE.muted}`}>{children}</p>
}
