import { useEffect, useRef } from 'react'
import { Outlet } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'
import { useProfile } from '../hooks/useProfile'
import { membershipGate, GATE } from '../lib/team'
import Btn from './Btn'

// ── Membership gate (ADR-72) ─────────────────────────────────────────────────
//
// Sits between ProtectedRoute (signed in?) and AppShell (the product). A
// signed-in user enters the shell ONLY while `users/{uid}` names a company
// and is not deactivated. Otherwise they see one plain screen and a sign-out
// button — never a shell full of "permission denied" registers.
//
// When membership is LOST while the app is open (deactivation), the shell —
// and every listener inside it — unmounts on the very next profile snapshot,
// and the client signs itself out. That is the client's part of revocation;
// Firestore and Storage deny every new request from the moment the profile
// changed (SECURITY.md → Team management).

const Spinner = () => (
  <div className="min-h-screen bg-brand-bg flex items-center justify-center" role="status" aria-label="Loading">
    <div className="w-8 h-8 border-2 border-brand-accent border-t-transparent rounded-full animate-spin" />
  </div>
)

const COPY = {
  [GATE.NONE]: {
    title: 'No active membership',
    body: 'This account is signed in but is not a member of a company. Ask your Company Admin for an invitation, then open the link they send you.',
  },
  [GATE.DEACTIVATED]: {
    title: 'Your membership was deactivated',
    body: 'A Company Admin removed this account from the company. If you think this is a mistake, ask them to invite you again.',
  },
  [GATE.ERROR]: {
    title: 'Could not load your membership',
    body: 'Your membership could not be read. Check your connection and reload; if it keeps failing, contact your Company Admin.',
  },
}

export default function MembershipGate() {
  const { user, signOut } = useAuth()
  const { profile, profileLoading, profileError } = useProfile()
  const gate = membershipGate({ profile, profileLoading, profileError })
  const wasActive = useRef(false)

  useEffect(() => {
    if (gate === GATE.ACTIVE) { wasActive.current = true; return }
    if (wasActive.current && (gate === GATE.NONE || gate === GATE.DEACTIVATED)) {
      wasActive.current = false
      signOut().catch(() => { /* the gate already hides every protected surface */ })
    }
  }, [gate, signOut])

  if (gate === GATE.LOADING) return <Spinner />
  if (gate === GATE.ACTIVE) return <Outlet />

  const copy = COPY[gate] ?? COPY[GATE.NONE]
  return (
    <div className="min-h-svh bg-brand-bg flex items-center justify-center px-4 py-10">
      <div className="w-full max-w-md rounded-2xl border border-brand-border bg-brand-sidebar p-6 sm:p-8">
        <h1 className="text-2xl font-bold text-brand-text mb-1.5">{copy.title}</h1>
        <p className="text-[13px] text-brand-text-soft leading-relaxed mb-2" role="status">{copy.body}</p>
        {user?.email && (
          <p className="text-xs text-brand-muted mb-6">Signed in as <span className="font-semibold text-brand-text">{user.email}</span></p>
        )}
        <div className="flex flex-wrap gap-3">
          {gate === GATE.ERROR && (
            <Btn variant="ghost" onClick={() => window.location.reload()}>Reload</Btn>
          )}
          <Btn onClick={() => signOut().catch(() => {})}>Sign out</Btn>
        </div>
      </div>
    </div>
  )
}
