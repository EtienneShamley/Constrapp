import { Link } from 'react-router-dom'

export default function ForgotPassword() {
  return (
    <div className="w-full max-w-sm">
      <div className="bg-brand-surface border border-brand-border rounded-2xl p-8 text-center">
        <h2 className="text-xl font-bold text-brand-text mb-2">Reset Password</h2>
        <p className="text-sm text-brand-muted mb-6">
          Password reset is coming soon. Contact your company admin if you need access.
        </p>
        <Link
          to="/login"
          className="text-brand-accent text-sm font-semibold hover:opacity-80 transition-opacity"
        >
          ← Back to sign in
        </Link>
      </div>
    </div>
  )
}
