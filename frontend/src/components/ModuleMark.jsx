// ── Constrapp module marks (ADR-48) ──────────────────────────────────────────
//
// Line marks drawn in currentColor on a 24-unit grid, coloured by the module
// brand tokens. Marks are DECORATIVE: every one sits beside the module's name
// in text, so the SVG is aria-hidden and never announced twice. Only PULSE™ and
// SHIELD™ have a mark — Quant™ and IQ™ get theirs at their own milestones.

const GLYPHS = {
  // Two-spike heartbeat line — the v5 canvas heartbeat, as a static mark.
  pulse:  'M2 12h4.5l2-5 4 10 2.5-7 1.5 2H22',
  shield: 'M12 3l7 3v5c0 4.4-2.9 8.3-7 10-4.1-1.7-7-5.6-7-10V6l7-3z',
}

const TONE = {
  pulse:  'text-brand-pulse',
  shield: 'text-brand-shield',
}

const TILE = {
  pulse:  'bg-brand-pulse/10 border-brand-pulse/20',
  shield: 'bg-brand-shield/10 border-brand-shield/20',
}

export function ModuleMark({ module, className = 'w-3.5 h-3.5' }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={`shrink-0 ${TONE[module]} ${className}`}
    >
      <path d={GLYPHS[module]} />
    </svg>
  )
}

// The v5 feature tile (36px, 10px radius, tinted fill and border) holding the
// mark. `beat` adds the PULSE indicator dot at the tile's corner, always lit by
// a soft token glow. Unless `paused`, it beats continuously — CSS only, and
// only under motion-safe, so reduced-motion users get the still, glowing dot.
// Every continuous beat MUST be rendered beside a BeatToggle (WCAG 2.2.2).
export function ModuleTile({ module, beat = false, paused = false }) {
  return (
    <span className={`relative inline-flex w-9 h-9 shrink-0 items-center justify-center rounded-[10px] border ${TILE[module]}`}>
      <ModuleMark module={module} className="w-[18px] h-[18px]" />
      {beat && (
        <span
          aria-hidden="true"
          className={`absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-brand-pulse shadow-[0_0_6px_var(--color-brand-pulse)] ${paused ? '' : 'motion-safe:animate-module-beat'}`}
        />
      )}
    </span>
  )
}

// The pause / resume control for a continuous beat (WCAG 2.2.2 Pause, Stop,
// Hide). Small and muted, but a real <button> with a 44px target and a label
// that names its action. Hidden under reduced motion, where nothing moves.
export function BeatToggle({ paused, onToggle }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={paused ? 'Resume heartbeat animation' : 'Pause heartbeat animation'}
      className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center gap-1.5 rounded-lg px-2 text-[11px] font-semibold text-brand-muted transition-colors hover:text-brand-text focus-visible:outline-2 focus-visible:outline-brand-accent motion-reduce:hidden"
    >
      <svg viewBox="0 0 12 12" fill="currentColor" aria-hidden="true" focusable="false" className="w-2.5 h-2.5 shrink-0">
        {paused ? <path d="M3 1.5v9l7.5-4.5z" /> : <path d="M2.5 1.5h2.5v9H2.5zM7 1.5h2.5v9H7z" />}
      </svg>
      {paused ? 'Resume' : 'Pause'}
    </button>
  )
}
