import { Link } from 'react-router-dom'
import { authLinkCls } from '../components/AuthField'

export default function CreateAccount() {
  return (
    <div className="text-center">
      <h1 className="text-2xl font-bold text-brand-text mb-2">Create Account</h1>
      {/* No public registration (ADR-27 / ADR-72). Accounts are created only
          through an invitation link sent by a Company Admin, on /accept-invite. */}
      <p className="text-[13px] text-brand-text-soft leading-relaxed mb-4">
        Constrapp accounts are created by invitation. Ask your Company Admin to invite you, then open the link in the email they send.
      </p>
      <Link to="/login" className={`${authLinkCls} text-sm font-semibold`}>
        ← Back to sign in
      </Link>
    </div>
  )
}
