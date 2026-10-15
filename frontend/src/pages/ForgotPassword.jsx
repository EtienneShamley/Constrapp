import { useId, useState } from 'react'
import { Link } from 'react-router-dom'
import { sendPasswordResetEmail } from 'firebase/auth'
import { auth } from '../lib/firebase'
import Btn from '../components/Btn'
import { AuthField, AuthError, authLinkCls } from '../components/AuthField'

// Firebase serves the reset-confirmation page itself, at the project's
// authDomain. No `actionCodeSettings` is passed and no in-app route exists for
// the confirmation step — that is deliberate for beta: a custom continue URL
// would need a hosted, allow-listed landing page we do not have yet.
export default function ForgotPassword() {
  const [email, setEmail]     = useState('')
  const [sent, setSent]       = useState(false)
  const [error, setError]     = useState('')
  const [loading, setLoading] = useState(false)
  const uid                   = useId()
  const errorId               = error ? `${uid}-error` : undefined

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
    <>
      <h1 className="text-2xl font-bold text-brand-text mb-1.5">Reset password</h1>

      {sent ? (
        <>
          <p role="status" className="text-[13px] text-brand-text-soft leading-relaxed mb-4">
            If an account exists for that address, a reset link is on its way.
            Check your inbox, and your spam folder.
          </p>
          <Link to="/login" className={authLinkCls}>
            ← Back to sign in
          </Link>
        </>
      ) : (
        <>
          <p className="text-[13px] text-brand-text-soft leading-relaxed mb-7">
            Enter your email address and we&rsquo;ll send you a link to set a new password.
          </p>

          <form onSubmit={handleSubmit} className="space-y-4">
            <AuthField
              id={`${uid}-email`}
              label="Email"
              type="email"
              value={email}
              onChange={e => { setEmail(e.target.value); setError('') }}
              required
              autoComplete="email"
              placeholder="you@company.com"
              errorId={errorId}
            />

            {error && <AuthError id={errorId}>{error}</AuthError>}

            <Btn
              type="submit"
              disabled={loading}
              className="w-full rounded-[9px] py-[13px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-accent"
            >
              {loading ? 'Sending…' : 'Send reset link'}
            </Btn>
          </form>

          <div className="mt-3">
            <Link to="/login" className={authLinkCls}>
              ← Back to sign in
            </Link>
          </div>
        </>
      )}
    </>
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
