import { createContext, useContext, useEffect, useState } from 'react'
import {
  onAuthStateChanged, signOut as firebaseSignOut,
  signInWithEmailAndPassword, createUserWithEmailAndPassword, updateProfile, sendPasswordResetEmail,
} from 'firebase/auth'
import { auth } from '../lib/firebase'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (firebaseUser) => {
      setUser(firebaseUser)
      setLoading(false)
    })
    return unsubscribe
  }, [])

  function signOut() {
    return firebaseSignOut(auth)
  }

  // ── Invitation acceptance (ADR-72) ───────────────────────────────────────
  // The /accept-invite page signs in, registers and requests password resets
  // through these, so no page imports `firebase/auth` directly. Registration
  // is the SUPPORTED browser-SDK flow: the browser creates the Auth account;
  // the trusted backend never sees a password. A bare Auth account has no
  // membership and therefore no access until acceptInvitation succeeds.
  function signIn(email, password) {
    return signInWithEmailAndPassword(auth, email, password)
  }

  async function register(email, password, displayName) {
    const cred = await createUserWithEmailAndPassword(auth, email, password)
    if (displayName) {
      try { await updateProfile(cred.user, { displayName }) } catch { /* name is also stored server-side */ }
    }
    return cred
  }

  function sendPasswordReset(email) {
    return sendPasswordResetEmail(auth, email)
  }

  return (
    <AuthContext.Provider value={{ user, loading, signOut, signIn, register, sendPasswordReset }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  return useContext(AuthContext)
}

export function getInitials(user) {
  if (!user) return '?'
  if (user.displayName) {
    const parts = user.displayName.trim().split(/\s+/)
    return (parts.length >= 2
      ? parts[0][0] + parts[parts.length - 1][0]
      : parts[0].slice(0, 2)
    ).toUpperCase()
  }
  const local = user.email.split('@')[0]
  const segments = local.split(/[._-]/)
  return (segments.length >= 2
    ? segments[0][0] + segments[1][0]
    : local.slice(0, 2)
  ).toUpperCase()
}

export function getDisplayName(user) {
  if (!user) return ''
  return user.displayName || user.email.split('@')[0]
}
