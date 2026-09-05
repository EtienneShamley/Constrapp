import { Component } from 'react'

// ── Application error boundary ───────────────────────────────────────────────
//
// Without this, ANY render-tree throw anywhere in the app produces a blank
// white page with no message and no way forward — the user cannot tell a bug
// from an outage, and support gets "it stopped working". This catches the
// throw and renders a readable fallback with a reload.
//
// ⚠️ NOTHING TECHNICAL REACHES THE USER. The error object and component stack
// are deliberately NOT rendered: a stack trace can carry document ids, paths
// and internal structure, and is meaningless to a site manager. They go to the
// browser console only, which is where a developer with the tab open will look.
// There is no external logging service in this increment (no Sentry, no new
// dependency) — that is deferred, along with structured error reporting.
//
// A class component because `componentDidCatch` / `getDerivedStateFromError`
// have no hook equivalent; this is the one place a class is still required.
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { hasError: false }
  }

  static getDerivedStateFromError() {
    return { hasError: true }
  }

  componentDidCatch(error, info) {
    // Console only — never rendered. See the note above.
    console.error('[Constrapp] Unhandled render error:', error, info?.componentStack)
  }

  render() {
    if (!this.state.hasError) return this.props.children

    return (
      <div className="min-h-screen bg-brand-bg flex items-center justify-center p-4">
        <div className="w-full max-w-sm bg-brand-surface border border-brand-border rounded-2xl p-8 text-center">
          <div className="flex items-center justify-center gap-3 mb-6">
            <svg width="32" height="32" viewBox="0 0 40 40" fill="none">
              <path d="M28 8L16 20L28 32" stroke="#00C9A7" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M20 8L8 20L20 32" stroke="#00C9A7" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" opacity="0.45" />
            </svg>
            <span className="text-xl font-black text-brand-text tracking-tight">Constrapp</span>
          </div>

          <h1 className="text-lg font-bold text-brand-text mb-2 m-0">Something went wrong</h1>
          {/* ⚠️ Says NOTHING about what did or did not happen to the user's data.
              A render can fail AFTER a Firestore write has already committed, so
              "your data has not been changed" would be a guarantee this boundary
              is in no position to make. Neutral copy is the only honest copy. */}
          <p className="text-sm text-brand-muted mb-6">
            Something went wrong while displaying this page. Reload Constrapp and
            try again. If the problem continues, contact your company administrator.
          </p>

          <button
            type="button"
            onClick={() => window.location.reload()}
            className="w-full bg-brand-accent text-brand-bg font-bold text-sm rounded-lg py-2.5 min-h-[44px] hover:opacity-90 transition-opacity cursor-pointer"
          >
            Reload Constrapp
          </button>
        </div>
      </div>
    )
  }
}
