import { Link } from 'react-router-dom'

export default function CreateAccount() {
  return (
    <div className="w-full max-w-sm">
      <div className="bg-brand-surface border border-brand-border rounded-2xl p-8 text-center">
        <h2 className="text-xl font-bold text-brand-text mb-2">Create Account</h2>
        <p className="text-sm text-brand-muted mb-6">
          Account creation is coming soon. Contact your company admin to be invited.
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
