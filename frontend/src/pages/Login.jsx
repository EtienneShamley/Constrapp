import { useId, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { signInWithEmailAndPassword } from 'firebase/auth'
import { auth } from '../lib/firebase'
import Btn from '../components/Btn'
import { AuthField, AuthError, authLinkCls } from '../components/AuthField'

export default function Login() {
  const [email, setEmail]       = useState('')
  const [password, setPassword] = useState('')
  const [error, setError]       = useState('')
  const [loading, setLoading]   = useState(false)
  const navigate                = useNavigate()
  const uid                     = useId()
  const errorId                 = error ? `${uid}-error` : undefined

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      await signInWithEmailAndPassword(auth, email, password)
      navigate('/', { replace: true })
    } catch (err) {
      setError(friendlyError(err.code))
    } finally {
      setLoading(false)
    }
  }

  return (
    <>
      <h1 className="text-2xl font-bold text-brand-text mb-1.5">Sign in</h1>
      <p className="text-[13px] text-brand-text-soft mb-7">Access your Constrapp workspace.</p>

      <form onSubmit={handleSubmit}>
        <div className="space-y-3.5">
          <AuthField
            id={`${uid}-email`}
            label="Email"
            type="email"
            value={email}
            onChange={e => setEmail(e.target.value)}
            required
            autoComplete="email"
            placeholder="you@company.com"
            errorId={errorId}
          />
          <AuthField
            id={`${uid}-password`}
            label="Password"
            type="password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            required
            autoComplete="current-password"
            placeholder="••••••••"
            errorId={errorId}
          />
        </div>

        <div className="flex justify-end mt-1 mb-3">
          <Link to="/forgot-password" className={authLinkCls}>
            Forgot password?
          </Link>
        </div>

        {error && (
          <div className="mb-4">
            <AuthError id={errorId}>{error}</AuthError>
          </div>
        )}

        <Btn
          type="submit"
          disabled={loading}
          className="w-full rounded-[9px] py-[13px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-accent"
        >
          {loading ? 'Signing in…' : 'Sign in'}
        </Btn>
      </form>

      {/* Constrapp accounts are provisioned OUT OF BAND — an Auth user plus a
          matching `users/{uid}` membership document, which no browser
          client may write (ADR-27). There is deliberately no self-service
          signup, so this stays non-interactive copy rather than a link into
          the /create-account stub. */}
      <div className="mt-6 flex gap-3 items-start rounded-[11px] border border-brand-border bg-brand-bg p-4">
        <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="size-4 shrink-0 mt-0.5 text-brand-accent">
          <circle cx="12" cy="12" r="10" />
          <path d="M12 16v-4M12 8h.01" />
        </svg>
        <p className="text-xs text-brand-text-soft leading-relaxed m-0">
          No account? Constrapp accounts are set up for you — contact your
          company admin.
        </p>
      </div>
    </>
  )
}

function friendlyError(code) {
  switch (code) {
    case 'auth/user-not-found':
    case 'auth/wrong-password':
    case 'auth/invalid-credential':
      return 'Incorrect email or password.'
    case 'auth/too-many-requests':
      return 'Too many attempts. Please try again later.'
    case 'auth/user-disabled':
      return 'This account has been disabled.'
    default:
      return 'Sign in failed. Please try again.'
  }
}
