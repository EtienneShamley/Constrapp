import { Navigate, Outlet } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'

const Logo = () => (
  <svg width="36" height="36" viewBox="0 0 40 40" fill="none">
    <path d="M28 8L16 20L28 32" stroke="#00C9A7" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M20 8L8 20L20 32" stroke="#00C9A7" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" opacity="0.45" />
  </svg>
)

const Spinner = () => (
  <div className="min-h-screen bg-brand-bg flex items-center justify-center">
    <div className="w-8 h-8 border-2 border-brand-accent border-t-transparent rounded-full animate-spin" />
  </div>
)

export default function AuthLayout() {
  const { user, loading } = useAuth()

  if (loading) return <Spinner />
  if (user) return <Navigate to="/" replace />

  return (
    <div className="min-h-screen bg-brand-bg flex flex-col items-center justify-center p-4">
      <div className="flex items-center gap-3 mb-8">
        <Logo />
        <span className="text-2xl font-black text-brand-text tracking-tight">Constrapp</span>
      </div>
      <Outlet />
      <p className="mt-8 text-xs text-brand-muted">
        Australian-built construction management
      </p>
    </div>
  )
}
