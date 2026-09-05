import { useState } from 'react'
import { Link } from 'react-router-dom'
import { sendPasswordResetEmail } from 'firebase/auth'
import { auth } from '../lib/firebase'

// Firebase serves the reset-confirmation page itself, at the project's
// authDomain. No `actionCodeSettings` is passed and no in-app route exists for
// the confirmation step — that is deliberate for beta: a custom continue URL
// would need a hosted, allow-listed landing page we do not have yet.
export default function ForgotPassword() {
  const [email, setEmail]     = useState('')
  const [sent, setSent]       = useState(false)
  const [error, setError]     = useState('')
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      await sendPasswordResetEmail(auth, email.trim())
      setSent(true)
    } catch (err) {
      // ⚠️ ACCOUNT ENUMERATION. Firebase answers `auth/user-not-found` for an
      // address with no account. Surfacing that turns this form into an oracle
      // for "does this person have a Constrapp login?", so an unknown address
      // takes the SAME success path as a real one — the email simply never
      // arrives. Only the two codes that help the user act are surfaced;
      // everything else is generic. (Login.jsx does the same thing, collapsing
      // user-not-found and wrong-password into one message.)
      if (err?.code === 'auth/user-not-found') {
        setSent(true)
      } else {
        setError(friendlyError(err?.code))
      }
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="w-full max-w-sm">
      <div className="bg-brand-surface border border-brand-border rounded-2xl p-8">
        <h2 className="text-xl font-bold text-brand-text mb-1">Reset password</h2>

        {sent ? (
          <>
            <p className="text-sm text-brand-muted mb-6">
              If an account exists for that address, a reset link is on its way.
              Check your inbox, and your spam folder.
            </p>
            <div className="text-center">
              <Link
                to="/login"
                className="text-brand-accent text-sm font-semibold hover:opacity-80 transition-opacity"
              >
                ← Back to sign in
              </Link>
            </div>
          </>
        ) : (
          <>
            <p className="text-sm text-brand-muted mb-6">
              Enter your email address and we&rsquo;ll send you a link to set a new password.
            </p>

            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block text-[11px] font-semibold text-brand-muted mb-1.5 uppercase tracking-wide">
                  Email
                </label>
                <input
                  type="email"
                  value={email}
                  onChange={e => { setEmail(e.target.value); setError('') }}
                  required
                  autoComplete="email"
                  placeholder="you@company.com"
                  className="w-full bg-brand-bg border border-brand-border rounded-lg px-3 py-2.5 text-brand-text text-sm outline-none focus:border-brand-accent transition-colors placeholder:text-brand-muted"
                />
              </div>

              {error && (
                <p className="text-brand-red text-xs leading-snug">{error}</p>
              )}

              <button
                type="submit"
                disabled={loading}
                className="w-full bg-brand-accent text-brand-bg font-bold text-sm rounded-lg py-2.5 min-h-[44px] hover:opacity-90 transition-opacity disabled:opacity-50 cursor-pointer"
              >
                {loading ? 'Sending…' : 'Send reset link'}
              </button>
            </form>

            <div className="mt-6 text-center">
              <Link
                to="/login"
                className="text-xs text-brand-muted hover:text-brand-text transition-colors"
              >
                ← Back to sign in
              </Link>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// Only the codes a user can ACT on are named. Everything else — including any
// code that would reveal whether an account exists — falls through to the
// generic message.
function friendlyError(code) {
  switch (code) {
    case 'auth/invalid-email':
      return 'That email address doesn’t look right.'
    case 'auth/too-many-requests':
      return 'Too many attempts. Please try again later.'
    default:
      return 'Could not send the reset link. Please try again.'
  }
}
