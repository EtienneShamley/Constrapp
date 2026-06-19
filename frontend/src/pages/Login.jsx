import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { signInWithEmailAndPassword } from 'firebase/auth'
import { auth } from '../lib/firebase'

export default function Login() {
  const [email, setEmail]       = useState('')
  const [password, setPassword] = useState('')
  const [error, setError]       = useState('')
  const [loading, setLoading]   = useState(false)
  const navigate                = useNavigate()

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
    <div className="w-full max-w-sm">
      <div className="bg-brand-surface border border-brand-border rounded-2xl p-8">
        <h2 className="text-xl font-bold text-brand-text mb-1">Sign in</h2>
        <p className="text-sm text-brand-muted mb-6">Enter your credentials to continue.</p>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-[11px] font-semibold text-brand-muted mb-1.5 uppercase tracking-wide">
              Email
            </label>
            <input
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              required
              autoComplete="email"
              placeholder="you@company.com"
              className="w-full bg-brand-bg border border-brand-border rounded-lg px-3 py-2.5 text-brand-text text-sm outline-none focus:border-brand-accent transition-colors placeholder:text-brand-muted"
            />
          </div>

          <div>
            <label className="block text-[11px] font-semibold text-brand-muted mb-1.5 uppercase tracking-wide">
              Password
            </label>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              required
              autoComplete="current-password"
              placeholder="••••••••"
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
            {loading ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        <div className="mt-6 flex flex-col gap-2.5 text-center">
          <Link
            to="/forgot-password"
            className="text-xs text-brand-muted hover:text-brand-text transition-colors"
          >
            Forgot password?
          </Link>
          <Link
            to="/create-account"
            className="text-xs text-brand-muted hover:text-brand-text transition-colors"
          >
            No account?{' '}
            <span className="text-brand-accent font-semibold">Create one</span>
          </Link>
        </div>
      </div>
    </div>
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
