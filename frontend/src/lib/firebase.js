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

// ── Local Firestore emulator (DEVELOPMENT ONLY, OPT-IN) ──────────────────────
//
// Points Firestore — and ONLY Firestore — at the local emulator so a developer
// can exercise the app against throwaway data and the local `firestore.rules`
// (the manual acceptance tests in docs/TESTING.md, e.g. §15r, need exactly
// this). PRODUCTION BEHAVIOUR IS UNCHANGED: this block is inert unless BOTH
// guards pass, and the default with no environment variable set is the real
// production Firestore.
//
// TWO guards, deliberately:
//   · `import.meta.env.DEV` — true only under `vite dev`. `VITE_*` values are
//     baked into the bundle at BUILD time, so without this a stray
//     VITE_USE_FIREBASE_EMULATOR=true in a build environment would ship a
//     production bundle pointed at localhost — broken for every user. This
//     makes that structurally impossible. (It also means `npm run preview`,
//     which serves a production build, always uses production Firestore.)
//   · the explicit opt-in flag below. Vite exposes env values as STRINGS, so
//     this compares against the string 'true' — an unset variable is
//     `undefined` and fails closed.
//
// Host/port mirror `frontend/firebase.json` → emulators.firestore.port (8080).
// 127.0.0.1 is used rather than `localhost` because on macOS `localhost` can
// resolve to IPv6 ::1 while the emulator listens on IPv4, which fails to
// connect for no visible reason.
//
// ⚠️ AUTH IS NOT EMULATED — only Firestore is. You still sign in against the
// real Firebase Auth project, but your `users/{uid}` membership document lives
// in the EMULATOR, which starts empty. Every rules check `get()`s that document,
// so until you seed it (plus the company and project documents) the app will
// correctly deny everything. That is the rules working, not a misconfiguration.
//
// ⚠️ Emulator data is in-memory and discarded when the emulator stops.
const USE_EMULATOR = import.meta.env.DEV
  && import.meta.env.VITE_USE_FIREBASE_EMULATOR === 'true'

if (USE_EMULATOR) {
  connectFirestoreEmulator(db, '127.0.0.1', 8080)
  // Stated loudly: it must never be ambiguous whether the data on screen is
  // real. This logs no secret and no PII.
  console.info(
    '[Constrapp] Firestore is connected to the LOCAL EMULATOR at 127.0.0.1:8080 — ' +
    'data is throwaway and is NOT production. Auth is still the real project.',
  )
}
