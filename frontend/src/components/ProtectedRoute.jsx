import { Navigate, Outlet } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'

const Spinner = () => (
  <div className="min-h-screen bg-brand-bg flex items-center justify-center">
    <div className="w-8 h-8 border-2 border-brand-accent border-t-transparent rounded-full animate-spin" />
  </div>
)

export default function ProtectedRoute() {
  const { user, loading } = useAuth()

  if (loading) return <Spinner />
  if (!user)   return <Navigate to="/login" replace />
  return <Outlet />
}
