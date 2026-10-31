// ── Constrapp module marks (ADR-48) ──────────────────────────────────────────
//
// Line marks drawn in currentColor on a 24-unit grid, coloured by the module
// brand tokens. Marks are DECORATIVE: every one sits beside the module's name
// in text, so the SVG is aria-hidden and never announced twice. PULSE™,
// SHIELD™, Quant™ (ADR-51) and GANTT™ (ADR-64) have a mark — IQ™ gets its own
// at its milestone.

const GLYPHS = {
  // Two-spike heartbeat line — the v5 canvas heartbeat, as a static mark.
  pulse:  'M2 12h4.5l2-5 4 10 2.5-7 1.5 2H22',
  shield: 'M12 3l7 3v5c0 4.4-2.9 8.3-7 10-4.1-1.7-7-5.6-7-10V6l7-3z',
  // A diagonal scale rule with three graduations — measurement, not AI.
  quant:  'M3 16l5 5L21 8l-5-5zM7.5 12.5l2 2M10.5 9.5l2 2M13.5 6.5l2 2',
  // Three staggered programme bars on a timeline — a Gantt, not a chart of
  // values. Static, like every mark.
  gantt:  'M3 4v16M3 7h9M7 12h11M11 17h10',
}

const TONE = {
  pulse:  'text-brand-pulse',
  shield: 'text-brand-shield',
  quant:  'text-brand-quant',
  gantt:  'text-brand-gantt',
}

const TILE = {
  pulse:  'bg-brand-pulse/10 border-brand-pulse/20',
  shield: 'bg-brand-shield/10 border-brand-shield/20',
  quant:  'bg-brand-quant/10 border-brand-quant/20',
  gantt:  'bg-brand-gantt/10 border-brand-gantt/20',
}

// The luminous dot's fill and its glow colour. `--module-glow` feeds the ONE
// shared `module-beat` keyframe and the static rest glow, so each module beats
// in its own token without a keyframe of its own. IQ™ joins here with its
// token when its page ships.
const DOT = {
  pulse:  'bg-brand-pulse [--module-glow:var(--color-brand-pulse)]',
  shield: 'bg-brand-shield [--module-glow:var(--color-brand-shield)]',
  quant:  'bg-brand-quant [--module-glow:var(--color-brand-quant)]',
  gantt:  'bg-brand-gantt [--module-glow:var(--color-brand-gantt)]',
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
// mark. `beat` adds the module's luminous dot at the tile's corner, always lit
// by a soft glow in the module's own token. Unless `paused`, it beats
// continuously — CSS only, and only under motion-safe, so reduced-motion users
// get the still, glowing dot. The dot is decorative: it never means the module
// is monitoring anything in the background. Every continuous beat MUST be
// rendered beside a BeatToggle (WCAG 2.2.2).
export function ModuleTile({ module, beat = false, paused = false }) {
  return (
    <span className={`relative inline-flex w-9 h-9 shrink-0 items-center justify-center rounded-[10px] border ${TILE[module]}`}>
      <ModuleMark module={module} className="w-[18px] h-[18px]" />
      {beat && (
        <span
          aria-hidden="true"
          className={`absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full ${DOT[module]} shadow-[0_0_6px_var(--module-glow)] ${paused ? '' : 'motion-safe:animate-module-beat'}`}
        />
      )}
    </span>
  )
}

// The pause / resume control for a continuous beat (WCAG 2.2.2 Pause, Stop,
// Hide). Small and muted, but a real <button> with a 44px target and a label
// that names its action and its subject (PULSE's heartbeat by default; SHIELD
// passes "glow animation"). Hidden under reduced motion, where nothing moves.
export function BeatToggle({ paused, onToggle, subject = 'heartbeat animation' }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={paused ? `Resume ${subject}` : `Pause ${subject}`}
      className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center gap-1.5 rounded-lg px-2 text-[11px] font-semibold text-brand-muted transition-colors hover:text-brand-text focus-visible:outline-2 focus-visible:outline-brand-accent motion-reduce:hidden"
    >
      <svg viewBox="0 0 12 12" fill="currentColor" aria-hidden="true" focusable="false" className="w-2.5 h-2.5 shrink-0">
        {paused ? <path d="M3 1.5v9l7.5-4.5z" /> : <path d="M2.5 1.5h2.5v9H2.5zM7 1.5h2.5v9H7z" />}
      </svg>
      {paused ? 'Resume' : 'Pause'}
    </button>
  )
}
