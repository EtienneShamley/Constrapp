// Form primitives shared by the auth pages (Login, ForgotPassword). Purely
// presentational — no auth logic lives here, and nothing here imports Firebase.
//
// Accessibility contract (pinned by tests/unit/authSurface.test.js):
//   - every input has a real <label htmlFor> bound to its id
//   - an error marks the input aria-invalid and points aria-describedby at the
//     message, which is announced via role="alert"
//   - inputs are text-base below sm (16px) so iOS Safari does not zoom on focus
//   - outline-hidden (not outline-none) keeps a visible outline in forced-colors

export function AuthField({ id, label, labelAside, errorId, ...inputProps }) {
  return (
    <div>
      <div className="flex items-end justify-between gap-3 mb-1.5">
        <label
          htmlFor={id}
          className="block text-[11px] font-bold text-brand-text-soft uppercase tracking-[0.5px]"
        >
          {label}
        </label>
        {labelAside}
      </div>
      <input
        id={id}
        aria-invalid={errorId ? true : undefined}
        aria-describedby={errorId || undefined}
        className="w-full bg-brand-bg border border-brand-border rounded-[9px] px-3.5 py-[11px] text-base sm:text-sm text-brand-text placeholder:text-brand-muted outline-hidden transition-colors focus:border-brand-accent focus:ring-2 focus:ring-brand-accent/30 aria-invalid:border-brand-red/60"
        {...inputProps}
      />
    </div>
  )
}

export function AuthError({ id, children }) {
  return (
    <div
      id={id}
      role="alert"
      className="flex items-start gap-2 bg-brand-red/10 border border-brand-red/40 text-brand-red rounded-lg px-3.5 py-2.5 text-xs leading-normal"
    >
      <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="size-4 shrink-0 mt-px">
        <circle cx="12" cy="12" r="10" />
        <path d="M12 8v4M12 16h.01" />
      </svg>
      <span>{children}</span>
    </div>
  )
}

// Text link styling for auth pages: teal, with a 44px tap target and a visible
// keyboard focus ring.
export const authLinkCls =
  'inline-flex items-center min-h-[44px] text-xs font-medium text-brand-accent hover:opacity-80 transition-opacity rounded focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-accent'
