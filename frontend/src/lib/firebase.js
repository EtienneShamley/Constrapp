import { initializeApp } from 'firebase/app'
import { getAuth } from 'firebase/auth'
import { getFirestore, connectFirestoreEmulator } from 'firebase/firestore'
import { getStorage } from 'firebase/storage'

const firebaseConfig = {
  apiKey:            import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain:        import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId:         import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket:     import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId:             import.meta.env.VITE_FIREBASE_APP_ID,
}

const app = initializeApp(firebaseConfig)

export const auth    = getAuth(app)
export const db      = getFirestore(app)
export const storage = getStorage(app)

// ── Local manual-acceptance emulator (FIRESTORE ONLY) ────────────────────────
//
// Points ONLY Firestore at the local emulator, so unpublished
// `frontend/firestore.rules` changes can be manually accepted before they are
// published to production. Started by `npm run test:boq`
// (frontend/scripts/boq-dev.mjs) — never by `npm run dev`.
//
// ⚠️ AUTH AND STORAGE ARE DELIBERATELY NOT EMULATED. The tester signs in with
// their REAL Constrapp account, so the real Firebase Auth uid is what the
// emulated Firestore rules authorise against — which is why the seed script
// writes `users/{uid}` membership documents for real uids.
//
// CONDITIONS — ALL THREE REQUIRED:
//   · import.meta.env.DEV                    — never in a production build
//   · VITE_USE_FIREBASE_EMULATOR === 'true'  — the explicit opt-in
//   · import.meta.env.MODE === 'emulator'    — set ONLY by `vite --mode emulator`
//
// ⚠️ WHY THE MODE CHECK IS LOAD-BEARING, NOT BELT-AND-BRACES.
// `.env.local` is git-ignored and long-lived, and a stale
// `VITE_USE_FIREBASE_EMULATOR=true` really can survive in it from an earlier
// local testing session (measured: a `.env.local` value DOES reach the bundle).
// On its own, the opt-in flag would therefore let a plain `npm run dev` point
// silently at an empty emulator while the developer believed they were on
// production data — during financial acceptance, the worst possible ambiguity.
// A `.env` file CANNOT set Vite's `MODE`; only the CLI can. So the mode check
// is the one condition a leftover file can never satisfy, and it is what keeps
// `npm run dev` provably unchanged.
//
// The port matches `frontend/firebase.json` (the same emulator the automated
// rules suite uses).
const useFirestoreEmulator =
  import.meta.env.DEV &&
  import.meta.env.VITE_USE_FIREBASE_EMULATOR === 'true' &&
  import.meta.env.MODE === 'emulator'

if (useFirestoreEmulator) {
  connectFirestoreEmulator(db, '127.0.0.1', 8080)
  // Loud on purpose — nobody should ever be unsure which datastore they are
  // looking at while doing manual financial acceptance.
  console.warn(
    '%c[Constrapp] FIRESTORE → LOCAL EMULATOR 127.0.0.1:8080 — data is disposable and NOT production. Auth is real.',
    'background:#F5A623;color:#000;font-weight:bold;padding:2px 6px;border-radius:3px',
  )
}
