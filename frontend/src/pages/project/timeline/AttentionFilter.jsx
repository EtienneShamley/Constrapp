import {
  ATTENTION_FILTER, ATTENTION_FLAG, ATTENTION_FLAG_ORDER, ATTENTION_FLAG_LABELS, ATTENTION_FLAG_HINTS,
  attentionCount,
} from '../../../lib/programmeAttention'

// ── Schedule attention filter (ADR-79) ───────────────────────────────────────
//
// One pressed-state choice: off, "needs attention" (any flag), or exactly one
// flag. PRESENTATION ONLY over lib/programmeAttention.js — every count is that
// module's, derived from the WHOLE programme, so a count never moves because
// another filter was applied, and a hidden predecessor still blocks.
//
// The definitions are the Constrap PULSE™ schedule indicators' own. "Later
// than baseline" needs a usable selected approved baseline; without one the
// choice is disabled and says why — it is never offered as a zero.

const chipCls = (active) =>
  `inline-flex min-h-[44px] items-center gap-1.5 rounded-lg border px-3 text-[12px] font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-brand-accent disabled:opacity-50 disabled:cursor-not-allowed ${
    active ? 'border-brand-accent/40 bg-brand-accent/15 text-brand-text' : 'border-brand-border text-brand-muted hover:text-brand-text hover:bg-brand-card'
  }`

const countCls = (n, active) =>
  `tabular-nums rounded px-1.5 py-0.5 text-[11px] font-bold ${
    n > 0 ? (active ? 'bg-brand-accent/20 text-brand-text' : 'bg-brand-red/10 text-brand-red') : 'bg-brand-bg text-brand-muted'
  }`

export default function AttentionFilter({ attention, value, onChange, baseline }) {
  const options = [
    { value: ATTENTION_FILTER.ANY, label: 'Needs attention', hint: 'Activities with at least one of the flags below. An activity with several flags is counted once.' },
    ...ATTENTION_FLAG_ORDER.map(f => ({ value: f, label: ATTENTION_FLAG_LABELS[f], hint: ATTENTION_FLAG_HINTS[f] })),
  ]
  const selected = options.find(o => o.value === value) ?? null
  const baselineOff = !attention?.baselineEvaluated

  return (
    <div>
      <p id="tl-attention-label" className="m-0 mb-1.5 text-[11px] font-bold uppercase tracking-[0.4px] text-brand-muted">
        Schedule attention
      </p>
      <div role="group" aria-labelledby="tl-attention-label" aria-describedby="tl-attention-hint" className="flex flex-wrap gap-1.5">
        {options.map(o => {
          const active = value === o.value
          const count = attentionCount(attention, o.value)
          const notEvaluated = o.value === ATTENTION_FLAG.LATER_THAN_BASELINE && baselineOff
          return (
            <button
              key={o.value}
              type="button"
              aria-pressed={active}
              // A pressed choice stays operable so it can always be released.
              disabled={notEvaluated && !active}
              title={notEvaluated ? baseline?.text : o.hint}
              className={chipCls(active)}
              onClick={() => onChange(active ? ATTENTION_FILTER.OFF : o.value)}
            >
              {o.label}
              {notEvaluated
                ? <span className="text-[10.5px] font-semibold text-brand-muted">not evaluated</span>
                : <span className={countCls(count, active)}>{count}</span>}
            </button>
          )
        })}
      </div>
      <p id="tl-attention-hint" className="m-0 mt-2 text-[11px] text-brand-muted">
        {selected
          ? selected.hint
          : 'Counts cover the whole programme, whatever else is filtered, and use the same definitions as the PULSE schedule indicators. One activity can carry several flags.'}
        {selected?.value === ATTENTION_FLAG.LATER_THAN_BASELINE && attention?.baselineEvaluated && baseline?.label
          ? ` Compared with ${baseline.label}.`
          : ''}
        {attention?.baselineEvaluated && baseline?.isActive === false && (
          <span className="block font-semibold text-brand-amber">{baseline.basisText}</span>
        )}
        {baselineOff && (!selected || selected.value === ATTENTION_FLAG.LATER_THAN_BASELINE || selected.value === ATTENTION_FILTER.ANY)
          ? ` Later than baseline is not evaluated: ${baseline?.text ?? 'no usable approved baseline is selected.'}`
          : ''}
      </p>
    </div>
  )
}
