import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import { doc, onSnapshot } from 'firebase/firestore'
import { db } from '../lib/firebase'
import { useAuth } from './useAuth'
import { EMPTY_PROFILE_SNAPSHOT, foldProfileReport } from '../lib/team'

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
  // snapshot is only trusted once its key matches the CURRENT user. The key
  // also carries the `attempt`, so a re-opened listener starts from nothing.
  //
  // ⚠️ ONLY A SERVER-CONFIRMED SNAPSHOT DECIDES MEMBERSHIP (tracker D3 #32;
  // lib/team.js → foldProfileReport). With the backend unreachable the SDK
  // answers this listener at once from its cache — on a cold load, with a
  // document that "does not exist". That is not "no membership", and a cached
  // active profile is not a membership either: both leave `profile` null and
  // `profileLoading` true until the server answers. `includeMetadataChanges`
  // is what delivers the server's answer when it only CONFIRMS the cache (a
  // genuinely missing document changes no data, so without it the confirmation
  // would never arrive and a non-member would wait for ever — measured).
  //
  // ⚠️ `profileLoading` IS AN AUTHORISATION GATE, not just a spinner — eight
  // financial pages read it, and ProjectRetention renders "no access" on
  // `!profileLoading && !canView`. It must stay true for the whole window in
  // which the membership document is unresolved, or those pages flash a false
  // denial. It is true until the SERVER has answered for THIS uid, or the
  // listener has failed.
  //
  // ⚠️ A settled `profile === null` with `profileLoading` false and no
  // `profileError` means the server CONFIRMED that the membership document
  // does not exist (users/{uid} is client-read-only and provisioned out of
  // band, ADR-27) — a distinct fact from "still loading", and the role gates
  // depend on the difference.
  //
  // Once the server has confirmed a profile, a dropped connection changes
  // nothing here: the confirmed profile stands until the server says otherwise.
  const [snap, setSnap] = useState({ key: null, ...EMPTY_PROFILE_SNAPSHOT })
  const attempt = snap.attempt

  useEffect(() => {
    if (!user) return undefined

    const key = `${user.uid}|${attempt}`
    const ref = doc(db, 'users', user.uid)
    // A callback that arrives after this listener was replaced (sign-out, an
    // account switch, a retry, unmount) must never reach the state of the
    // listener that replaced it.
    let live = true
    const unsubscribe = onSnapshot(
      ref,
      { includeMetadataChanges: true },
      (docSnap) => {
        if (!live) return
        setSnap((s) => foldProfileReport(s, key, {
          profile: docSnap.exists() ? { id: docSnap.id, ...docSnap.data() } : null,
          fromCache: docSnap.metadata.fromCache,
          hasPendingWrites: docSnap.metadata.hasPendingWrites,
        }))
      },
      // A failed read (most often a rules rejection). Terminal for this
      // listener — `retryProfile` opens another.
      (err) => {
        if (!live) return
        setSnap((s) => foldProfileReport(s, key, { code: err?.code ?? 'unknown' }))
      },
    )
    return () => {
      live = false
      unsubscribe()
      // What a closed listener established dies with it. Without this, signing
      // out and back in as the SAME uid in one tab would find the earlier
      // confirmation still under its key and enter the shell before the server
      // had answered for the new session.
      setSnap((s) => (s.key === key ? { key: null, ...EMPTY_PROFILE_SNAPSHOT, attempt: s.attempt } : s))
    }
  }, [user, attempt])

  // Re-open the listener after a failed read. Reads only. Resetting `key`
  // returns the gate to "loading"; nothing confirmed earlier is kept.
  const retryProfile = useCallback(() => {
    setSnap((s) => (s.error ? { key: null, ...EMPTY_PROFILE_SNAPSHOT, attempt: s.attempt + 1 } : s))
  }, [])

  // Derived, at render time: no synchronous setState in the effect. Signed out
  // we are idle (no profile, not loading — ProtectedRoute has already
  // redirected); signed in we are loading until the SERVER has answered for
  // THAT uid.
  const targetKey = user ? `${user.uid}|${attempt}` : null
  const settled = targetKey !== null && snap.key === targetKey
  // Exposed for the membership gate (ADR-72): a FAILED profile read must
  // present as "could not load your membership", never as "no membership".
  const profileError = settled ? snap.error : false
  const profileErrorCode = profileError ? snap.readCode : null
  const confirmed = settled && snap.confirmed === true
  // The listener has reported, but only from the cache: the server is not
  // answering. Still unresolved — it is a kind of loading, with a name.
  const profileWaiting = settled && !confirmed && !profileError
  const settledProfile = settled ? snap.profile : null
  const profile = confirmed ? settledProfile : null
  const profileLoading = (targetKey !== null && !settled) || profileWaiting

  return (
    <ProfileContext.Provider value={{ profile, profileLoading, profileError, profileErrorCode, profileWaiting, retryProfile }}>
      {children}
    </ProfileContext.Provider>
  )
}

export function useProfile() {
  return useContext(ProfileContext)
}
