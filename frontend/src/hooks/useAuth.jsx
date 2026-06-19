import { createContext, useContext, useEffect, useState } from 'react'
import { onAuthStateChanged, signOut as firebaseSignOut } from 'firebase/auth'
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

  return (
    <AuthContext.Provider value={{ user, loading, signOut }}>
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
