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
//
// The shell is entered only on a SERVER-CONFIRMED active profile (tracker
// D3 #32). While the server has not answered, this renders the spinner; once
// the SDK reports that it is answering from its cache (the server is
// unreachable) it says so — *Waiting for the server* — and continues by itself
// when the server answers. *No active membership* and *deactivated* appear
// only when the server said so. A connection lost AFTER confirmation changes
// nothing here: the shell stays, and nobody is signed out for being offline.

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
  [GATE.INVALID]: {
    title: 'Your membership needs attention',
    body: 'This account belongs to a company, but its membership record is incomplete or not recognised, so the app cannot be opened. This is not a connection problem. Ask your Company Admin to contact Constrap support; this page will continue by itself once the record is corrected.',
  },
  [GATE.WAITING]: {
    title: 'Waiting for the server',
    body: 'The server has not answered yet, so your membership cannot be confirmed. This page will continue by itself when the connection returns.',
  },
  [GATE.REFUSED]: {
    title: 'Your membership could not be confirmed',
    body: 'The server refused to read your membership. Your access may have changed — try again, or sign out and in again. If it keeps happening, contact your Company Admin.',
  },
  [GATE.ERROR]: {
    title: 'Could not load your membership',
    body: 'Your membership could not be read from the server. This is a loading failure, not a missing membership. Check your connection and try again.',
  },
}

export default function MembershipGate() {
  const { user, signOut } = useAuth()
  const { profile, profileLoading, profileError, profileErrorCode, profileWaiting, retryProfile } = useProfile()
  const gate = membershipGate({ profile, profileLoading, profileError, profileErrorCode, profileWaiting })
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

  // An unknown state is a loading failure, never a statement about membership.
  const copy = COPY[gate] ?? COPY[GATE.ERROR]
  const canRetry = gate === GATE.ERROR || gate === GATE.REFUSED
  return (
    <div data-membership-gate={gate} className="min-h-svh bg-brand-bg flex items-center justify-center px-4 py-10">
      <div className="w-full max-w-md rounded-2xl border border-brand-border bg-brand-sidebar p-6 sm:p-8">
        <h1 className="text-2xl font-bold text-brand-text mb-1.5">{copy.title}</h1>
        <p className="text-[13px] text-brand-text-soft leading-relaxed mb-2" role="status">{copy.body}</p>
        {user?.email && (
          <p className="text-xs text-brand-muted mb-6">Signed in as <span className="font-semibold text-brand-text">{user.email}</span></p>
        )}
        <div className="flex flex-wrap gap-3">
          {canRetry && (
            <Btn variant="ghost" onClick={retryProfile}>Try again</Btn>
          )}
          <Btn onClick={() => signOut().catch(() => {})}>Sign out</Btn>
        </div>
      </div>
    </div>
  )
}
