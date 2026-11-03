import { useEffect, useId, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import Btn from '../components/Btn'
import { AuthField, AuthError, authLinkCls } from '../components/AuthField'
import { useAuth } from '../hooks/useAuth'
import { useTeam } from '../hooks/useTeam'
import { formatRole } from '../lib/formatters'
import {
  parseInviteFragment, readPendingInvite, storePendingInvite, clearPendingInvite,
  acceptStepFor, ACCEPT_STEP, teamErrorMessage, authErrorMessage, passwordProblem, PASSWORD_MIN,
} from '../lib/team'

// ── /accept-invite (ADR-72) ──────────────────────────────────────────────────
//
// The ONE public entry point for a new team member. The link's fragment holds
// the credential; it is moved into sessionStorage and stripped from the
// address bar on the first render, so it survives the sign-in round trip
// without ever reaching a server log, a Referer header or analytics.
//
//   1. previewInvitation (App Check, no sign-in) — company, role, account state
//   2. the person registers (browser Firebase Auth SDK), signs in, or is
//      already signed in as the invited email
//   3. acceptInvitation (signed in) — the backend checks token possession AND
//      the Auth record's email, then writes the membership atomically
//
// No page imports `firebase/*`: Auth goes through useAuth, callables through
// useTeam. The backend never sees a password.

function loadCredential() {
  const fromHash = parseInviteFragment(window.location.hash)
  if (fromHash) {
    storePendingInvite(window.sessionStorage, fromHash)
    window.history.replaceState(null, '', window.location.pathname)
    return fromHash
  }
  return readPendingInvite(window.sessionStorage)
}

const submitCls = 'w-full rounded-[9px] py-[13px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-accent'

export default function AcceptInvite() {
  const { user, signIn, register, sendPasswordReset, signOut } = useAuth()
  const team = useTeam()
  const navigate = useNavigate()
  const uid = useId()

  const [cred] = useState(loadCredential)
  const [preview, setPreview] = useState({ phase: cred ? 'loading' : 'missing', data: null, message: '' })
  const [name, setName]         = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm]   = useState('')
  const [error, setError]       = useState('')
  const [busy, setBusy]         = useState(false)
  const [resetSent, setResetSent] = useState(false)

  useEffect(() => {
    if (!cred) return undefined
    let cancelled = false
    team.previewInvitation(cred)
      .then(data => { if (!cancelled) setPreview({ phase: 'ready', data, message: '' }) })
      .catch(err => { if (!cancelled) setPreview({ phase: 'error', data: null, message: teamErrorMessage(err) }) })
    return () => { cancelled = true }
  }, [cred, team])

  const signedInEmail = user?.email ? user.email.toLowerCase() : null
  const step = preview.phase === 'ready' ? acceptStepFor(preview.data, signedInEmail) : null
  const errorId = error ? `${uid}-error` : undefined
  const invite = preview.data

  async function accept() {
    setBusy(true); setError('')
    try {
      const trimmed = name.trim()
      await team.acceptInvitation({ ...cred, ...(trimmed ? { name: trimmed } : {}) })
      clearPendingInvite(window.sessionStorage)
      navigate('/', { replace: true })
    } catch (err) {
      setError(teamErrorMessage(err))
      setBusy(false)
    }
  }

  async function onRegister(e) {
    e.preventDefault()
    if (!name.trim()) { setError('Enter your name.'); return }
    const problem = passwordProblem(password, confirm)
    if (problem) { setError(problem); return }
    setBusy(true); setError('')
    try {
      await register(invite.email, password, name.trim())
    } catch (err) {
      setError(authErrorMessage(err?.code)); setBusy(false); return
    }
    await accept()
  }

  async function onSignIn(e) {
    e.preventDefault()
    setBusy(true); setError('')
    try {
      await signIn(invite.email, password)
    } catch (err) {
      setError(authErrorMessage(err?.code)); setBusy(false); return
    }
    if (step === ACCEPT_STEP.ALREADY_MEMBER) { clearPendingInvite(window.sessionStorage); navigate('/', { replace: true }); return }
    await accept()
  }

  async function onReset() {
    setError('')
    try { await sendPasswordReset(invite.email) } catch { /* same outcome either way — no enumeration */ }
    setResetSent(true)
  }

  async function onSwitchAccount() {
    setError('')
    try { await signOut() } catch { setError('Could not sign out. Please try again.') }
  }

  // ── Not ready ──────────────────────────────────────────────────────────────
  if (preview.phase === 'missing') {
    return (
      <>
        <h1 className="text-2xl font-bold text-brand-text mb-1.5">Invitation link incomplete</h1>
        <p className="text-[13px] text-brand-text-soft leading-relaxed mb-4">
          Open the full link from your invitation email. If it has expired, ask your Company Admin to send a new one.
        </p>
        <Link to="/login" className={authLinkCls}>← Back to sign in</Link>
      </>
    )
  }
  if (preview.phase === 'loading') {
    return (
      <>
        <h1 className="text-2xl font-bold text-brand-text mb-1.5">Checking your invitation</h1>
        <p role="status" className="text-[13px] text-brand-text-soft">One moment…</p>
      </>
    )
  }
  if (preview.phase === 'error') {
    return (
      <>
        <h1 className="text-2xl font-bold text-brand-text mb-1.5">Invitation unavailable</h1>
        <div className="mb-4"><AuthError id={`${uid}-preview-error`}>{preview.message}</AuthError></div>
        <Link to="/login" className={authLinkCls}>← Back to sign in</Link>
      </>
    )
  }

  const intro = (
    <p className="text-[13px] text-brand-text-soft leading-relaxed mb-6">
      {invite.inviterName ? `${invite.inviterName} has invited you` : 'You have been invited'} to join{' '}
      <span className="font-bold text-brand-text">{invite.companyName || 'a company'}</span> as{' '}
      <span className="font-bold text-brand-text">{formatRole(invite.role)}</span>.
      <span className="block mt-1 text-xs text-brand-muted">Invitation for {invite.email}</span>
    </p>
  )

  // ── Terminal states ────────────────────────────────────────────────────────
  if (step === ACCEPT_STEP.OTHER_COMPANY || step === ACCEPT_STEP.BLOCKED) {
    return (
      <>
        <h1 className="text-2xl font-bold text-brand-text mb-1.5">This invitation can’t be accepted</h1>
        {intro}
        <AuthError id={`${uid}-blocked`}>
          {step === ACCEPT_STEP.OTHER_COMPANY
            ? 'This email address already belongs to another company on Constrapp, so it cannot join a second one.'
            : 'This account cannot accept invitations. Contact your administrator.'}
        </AuthError>
        <div className="mt-3"><Link to="/login" className={authLinkCls}>← Back to sign in</Link></div>
      </>
    )
  }

  if (step === ACCEPT_STEP.SWITCH_ACCOUNT) {
    return (
      <>
        <h1 className="text-2xl font-bold text-brand-text mb-1.5">Switch account to continue</h1>
        {intro}
        <p className="text-[13px] text-brand-text-soft leading-relaxed mb-4">
          You are signed in as <span className="font-semibold text-brand-text">{user.email}</span>, but this invitation was sent to{' '}
          <span className="font-semibold text-brand-text">{invite.email}</span>. Sign out, then continue with the invited address.
        </p>
        {error && <div className="mb-4"><AuthError id={errorId}>{error}</AuthError></div>}
        <Btn onClick={onSwitchAccount} className={submitCls}>Sign out and continue</Btn>
      </>
    )
  }

  if (step === ACCEPT_STEP.ACCEPT) {
    return (
      <>
        <h1 className="text-2xl font-bold text-brand-text mb-1.5">Accept your invitation</h1>
        {intro}
        {error && <div className="mb-4"><AuthError id={errorId}>{error}</AuthError></div>}
        <Btn onClick={accept} disabled={busy} className={submitCls}>{busy ? 'Joining…' : `Join ${invite.companyName || 'the company'}`}</Btn>
      </>
    )
  }

  if (step === ACCEPT_STEP.ALREADY_MEMBER && signedInEmail) {
    return (
      <>
        <h1 className="text-2xl font-bold text-brand-text mb-1.5">You’re already a member</h1>
        {intro}
        <Btn onClick={() => { clearPendingInvite(window.sessionStorage); navigate('/', { replace: true }) }} className={submitCls}>Open Constrapp</Btn>
      </>
    )
  }

  // ── Register ───────────────────────────────────────────────────────────────
  if (step === ACCEPT_STEP.REGISTER) {
    return (
      <>
        <h1 className="text-2xl font-bold text-brand-text mb-1.5">Create your account</h1>
        {intro}
        <form onSubmit={onRegister}>
          <div className="space-y-3.5">
            <AuthField id={`${uid}-email`} label="Email" type="email" value={invite.email} readOnly autoComplete="username" errorId={errorId} />
            <AuthField id={`${uid}-name`} label="Your name" type="text" value={name} onChange={e => setName(e.target.value)} required autoComplete="name" placeholder="Jo Builder" errorId={errorId} />
            <AuthField id={`${uid}-password`} label="Password" type="password" value={password} onChange={e => setPassword(e.target.value)} required autoComplete="new-password" placeholder={`At least ${PASSWORD_MIN} characters`} errorId={errorId} />
            <AuthField id={`${uid}-confirm`} label="Confirm password" type="password" value={confirm} onChange={e => setConfirm(e.target.value)} required autoComplete="new-password" placeholder="••••••••••••" errorId={errorId} />
          </div>
          {error && <div className="mt-4"><AuthError id={errorId}>{error}</AuthError></div>}
          <Btn type="submit" disabled={busy} className={`${submitCls} mt-4`}>{busy ? 'Creating account…' : 'Create account and join'}</Btn>
        </form>
      </>
    )
  }

  // ── Sign in (existing / reactivated / already-member) ──────────────────────
  return (
    <>
      <h1 className="text-2xl font-bold text-brand-text mb-1.5">
        {step === ACCEPT_STEP.REACTIVATED ? 'Welcome back' : 'Sign in to accept'}
      </h1>
      {intro}
      {step === ACCEPT_STEP.REACTIVATED && (
        <p role="status" className="text-[13px] text-brand-text-soft leading-relaxed mb-4">
          Your account has been reactivated. Sign in with your existing password, or send yourself a reset link.
        </p>
      )}
      {step === ACCEPT_STEP.ALREADY_MEMBER && (
        <p role="status" className="text-[13px] text-brand-text-soft leading-relaxed mb-4">
          This address is already a member of {invite.companyName || 'the company'} — just sign in.
        </p>
      )}
      <form onSubmit={onSignIn}>
        <div className="space-y-3.5">
          <AuthField id={`${uid}-email`} label="Email" type="email" value={invite.email} readOnly autoComplete="username" errorId={errorId} />
          <AuthField id={`${uid}-password`} label="Password" type="password" value={password} onChange={e => setPassword(e.target.value)} required autoComplete="current-password" placeholder="••••••••" errorId={errorId} />
        </div>
        <div className="flex justify-end mt-1 mb-3">
          {resetSent
            ? <span role="status" className="text-xs text-brand-text-soft py-3">If an account exists for that address, a reset link is on its way.</span>
            : <button type="button" onClick={onReset} className={authLinkCls}>Forgot password?</button>}
        </div>
        {error && <div className="mb-4"><AuthError id={errorId}>{error}</AuthError></div>}
        <Btn type="submit" disabled={busy} className={submitCls}>
          {busy ? 'Signing in…' : step === ACCEPT_STEP.ALREADY_MEMBER ? 'Sign in' : 'Sign in and join'}
        </Btn>
      </form>
    </>
  )
}
