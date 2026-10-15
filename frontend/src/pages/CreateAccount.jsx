import { Link } from 'react-router-dom'
import { authLinkCls } from '../components/AuthField'

export default function CreateAccount() {
  return (
    <div className="text-center">
      <h1 className="text-2xl font-bold text-brand-text mb-2">Create Account</h1>
      <p className="text-[13px] text-brand-text-soft leading-relaxed mb-4">
        Account creation is coming soon. Contact your company admin to be invited.
      </p>
      <Link to="/login" className={`${authLinkCls} text-sm font-semibold`}>
        ← Back to sign in
      </Link>
    </div>
  )
}
