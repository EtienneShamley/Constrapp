import { createContext, useContext, useEffect, useState } from 'react'
import { doc, onSnapshot } from 'firebase/firestore'
import { db } from '../lib/firebase'
import { useAuth } from './useAuth'

const ProfileContext = createContext(null)

export function ProfileProvider({ children }) {
  const { user } = useAuth()
  // Live subscription state, tagged with the target (`key`) it belongs to —
  // the keyed-snapshot pattern; the single-document reference is
  // useProjectCommercial. The effect is subscription-only: state is written
  // ONLY from the async onSnapshot callbacks, never synchronously in the effect
  // body, so profile/loading are DERIVED at render time below
  // (react-hooks/set-state-in-effect).
  //
  // ⚠️ THE TARGET IS THE SIGNED-IN uid — the only non-company key in the app.
  // Keying on the uid is what makes an account switch safe: signing out of A
  // and into B can no longer show A's profile for even one frame, because the
  // snapshot is only trusted once its key matches the CURRENT user.
  //
  // ⚠️ `profileLoading` IS AN AUTHORISATION GATE, not just a spinner — eight
  // financial pages read it, and ProjectRetention renders "no access" on
  // `!profileLoading && !canView`. It must stay true for the whole window in
  // which the membership document is unresolved, or those pages flash a false
  // denial. With a user present the target is non-null, so loading stays true
  // until THAT uid's snapshot lands.
  //
  // ⚠️ A settled `profile === null` means the membership document DOES NOT
  // EXIST (users/{uid} is client-read-only and provisioned out of band, ADR-27)
  // — a distinct fact from "still loading", and the role gates depend on the
  // difference.
  //
  // `error` is tracked here for pattern uniformity but deliberately NOT
  // exposed: adding a `profileError` would change this provider's public
  // context value. A rejected read still presents as a null profile, exactly as
  // it did before this migration.
  const [snap, setSnap] = useState({ key: null, profile: null, error: false })

  useEffect(() => {
    if (!user) return undefined

    const key = user.uid
    const ref = doc(db, 'users', user.uid)
    const unsubscribe = onSnapshot(
      ref,
      (docSnap) => setSnap({
        key,
        profile: docSnap.exists() ? { id: docSnap.id, ...docSnap.data() } : null,
        error: false,
      }),
      // Firestore read error (e.g. missing doc or rules rejection) — degrade
      // gracefully.
      () => setSnap({ key, profile: null, error: true }),
    )
    return unsubscribe
  }, [user])

  // Derived, at render time: no synchronous setState in the effect. Signed out
  // we are idle (no profile, not loading — ProtectedRoute has already
  // redirected); signed in we are loading until the subscription reports for
  // THAT uid.
  const targetKey = user?.uid ?? null
  const settled = targetKey !== null && snap.key === targetKey
  const profile = settled ? snap.profile : null
  const profileLoading = targetKey !== null && !settled

  return (
    <ProfileContext.Provider value={{ profile, profileLoading }}>
      {children}
    </ProfileContext.Provider>
  )
}

export function useProfile() {
  return useContext(ProfileContext)
}
