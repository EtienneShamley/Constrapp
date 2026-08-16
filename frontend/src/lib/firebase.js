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

// ── Local acceptance environment — LAUNCHER-ONLY ─────────────────────────────
//
// `npm run test:tender` (scripts/tender-dev.mjs) points FIRESTORE — and nothing
// else — at a local emulator whose data is discarded on exit. THREE independent
// conditions must ALL hold before a single byte is redirected:
//
//   1. import.meta.env.DEV                          — impossible in a production build
//   2. import.meta.env.MODE === 'emulator'          — only `vite --mode emulator`
//   3. VITE_USE_FIREBASE_EMULATOR === 'true'        — injected into the launcher's
//                                                     CHILD PROCESS env, never written
//                                                     to .env.local or any .env file
//
// Condition 2 is what `npm run dev` can never satisfy (its mode is
// 'development'), and condition 3 cannot be switched on by editing .env.local
// alone because condition 2 would still fail. Removing any one of the three
// sends the app straight back to the real project.
//
// ⚠️ AUTH AND STORAGE ARE NEVER EMULATED. Sign-in stays against the real
// Firebase project, which is exactly why the acceptance seed must write a
// profile for a REAL uid — the signed-in user's own. Emulating auth would let a
// fabricated uid pass, which is not what we want to accept.
if (
  import.meta.env.DEV &&
  import.meta.env.MODE === 'emulator' &&
  import.meta.env.VITE_USE_FIREBASE_EMULATOR === 'true'
) {
  const host = import.meta.env.VITE_FIRESTORE_EMULATOR_HOST || '127.0.0.1'
  const port = Number(import.meta.env.VITE_FIRESTORE_EMULATOR_PORT || 8080)
  connectFirestoreEmulator(db, host, port)
  // Loud, permanent banner: no one should ever mistake this tab for production.
  console.warn(
    `[Constrapp] FIRESTORE EMULATOR MODE — reads and writes go to ${host}:${port} ` +
    `(project "${firebaseConfig.projectId}"). Auth is REAL. No production data is touched.`,
  )
}
