import { initializeApp } from 'firebase/app'
import { getAuth } from 'firebase/auth'
import { getFirestore, connectFirestoreEmulator } from 'firebase/firestore'
import { getStorage, connectStorageEmulator } from 'firebase/storage'

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

// ── Local manual-acceptance emulator (FIRESTORE ONLY) — LAUNCHER-ONLY ─────────
//
// Points ONLY Firestore at a local emulator, so unpublished
// `frontend/firestore.rules` changes and seeded acceptance fixtures can be
// exercised before anything is published. Started ONLY by the one-command
// launchers — `npm run test:boq` (scripts/boq-dev.mjs), `npm run test:tender`
// (scripts/tender-dev.mjs) and `npm run test:credit-notes`
// (scripts/credit-notes-dev.mjs) — never by `npm run dev`. Emulator data is
// disposable and discarded on exit.
//
// ⚠️ AUTH AND STORAGE ARE DELIBERATELY NOT EMULATED. The tester signs in with
// their REAL Constrapp account, so the real Firebase Auth uid is what the
// emulated Firestore rules authorise against — which is why both seed scripts
// write `users/{uid}` membership documents for REAL uids.
//
// CONDITIONS — ALL THREE REQUIRED:
//   · import.meta.env.DEV                    — never in a production build
//   · import.meta.env.MODE === 'emulator'    — set ONLY by `vite --mode emulator`
//   · VITE_USE_FIREBASE_EMULATOR === 'true'  — the explicit opt-in, injected into
//                                              the launcher's CHILD PROCESS env
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
// `npm run dev` provably unchanged. Removing any one of the three sends the
// app straight back to the real project.
//
// Host/port default to the emulator in `frontend/firebase.json` (the same one
// the automated rules suite uses); a launcher may override them via
// VITE_FIRESTORE_EMULATOR_HOST / VITE_FIRESTORE_EMULATOR_PORT in its child env.
const useFirestoreEmulator =
  import.meta.env.DEV &&
  import.meta.env.MODE === 'emulator' &&
  import.meta.env.VITE_USE_FIREBASE_EMULATOR === 'true'

if (useFirestoreEmulator) {
  const host = import.meta.env.VITE_FIRESTORE_EMULATOR_HOST || '127.0.0.1'
  const port = Number(import.meta.env.VITE_FIRESTORE_EMULATOR_PORT || 8080)
  connectFirestoreEmulator(db, host, port)
  // Loud on purpose — nobody should ever be unsure which datastore they are
  // looking at while doing manual financial acceptance.
  console.warn(
    `%c[Constrapp] FIRESTORE → LOCAL EMULATOR ${host}:${port} (project "${firebaseConfig.projectId}") — data is disposable and NOT production. Auth is real.`,
    'background:#F5A623;color:#000;font-weight:bold;padding:2px 6px;border-radius:3px',
  )
}

// ── Local Cloud Storage emulator — LAUNCHER-ONLY, and only WITH Firestore ─────
//
// The Quant™ 1A launcher (`npm run test:quant`, scripts/quant-dev.mjs) also
// emulates FILE STORAGE, so the takeoff viewer can fetch a seeded drawing's
// bytes without the production bucket (and without its CORS prerequisite —
// docs/DEPLOYMENT.md). It requires EVERY Firestore condition above PLUS a
// fourth explicit opt-in, so none of the older launchers (`test:boq`,
// `test:tender`, `test:credit-notes`) change behaviour: they keep real
// Storage, exactly as before, because they never set the fourth flag.
//
// Storage is never emulated on its own: a Firestore-on-production /
// Storage-on-emulator split would let a real drawing record point at
// throwaway bytes, which is the one ambiguity this file exists to prevent.
const useStorageEmulator =
  useFirestoreEmulator &&
  import.meta.env.VITE_USE_STORAGE_EMULATOR === 'true'

if (useStorageEmulator) {
  const host = import.meta.env.VITE_STORAGE_EMULATOR_HOST || '127.0.0.1'
  const port = Number(import.meta.env.VITE_STORAGE_EMULATOR_PORT || 9199)
  connectStorageEmulator(storage, host, port)
  console.warn(
    `%c[Constrapp] STORAGE → LOCAL EMULATOR ${host}:${port} (bucket "${firebaseConfig.storageBucket}") — files are disposable and NOT production.`,
    'background:#F5A623;color:#000;font-weight:bold;padding:2px 6px;border-radius:3px',
  )
}
