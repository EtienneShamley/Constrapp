import { initializeApp } from 'firebase/app'
import { getAuth, connectAuthEmulator } from 'firebase/auth'
import { getFirestore, connectFirestoreEmulator } from 'firebase/firestore'
import { getStorage, connectStorageEmulator } from 'firebase/storage'
import { getFunctions, connectFunctionsEmulator } from 'firebase/functions'
import { initializeAppCheck, ReCaptchaEnterpriseProvider, CustomProvider } from 'firebase/app-check'

const firebaseConfig = {
  apiKey:            import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain:        import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId:         import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket:     import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId:             import.meta.env.VITE_FIREBASE_APP_ID,
}

const app = initializeApp(firebaseConfig)

// ── Emulator opt-in flags — DECLARED here, EXPLAINED where they are used ─────
//
// Declared before the App Check block because App Check must know, before it
// is initialised, whether the callables are served by the LOCAL Functions
// emulator. The conditions and the reasons for each are documented at the
// blocks that act on them further down ("Local manual-acceptance emulator"
// and "Local Functions + Auth emulators"); nothing about them changed.
const useFirestoreEmulator =
  import.meta.env.DEV &&
  import.meta.env.MODE === 'emulator' &&
  import.meta.env.VITE_USE_FIREBASE_EMULATOR === 'true'
const useFunctionsEmulator =
  useFirestoreEmulator &&
  import.meta.env.VITE_USE_FUNCTIONS_EMULATOR === 'true' &&
  import.meta.env.VITE_USE_AUTH_EMULATOR === 'true'

// ── Firebase App Check (ADR-72) ──────────────────────────────────────────────
//
// Every team-management callable is deployed with `enforceAppCheck: true`, so
// a request without a valid App Check token is refused before the handler
// runs. The web app proves itself with reCAPTCHA Enterprise; the site key is
// PUBLIC (like the rest of the Firebase web config) and lives in
// VITE_FIREBASE_APPCHECK_SITE_KEY. Without it App Check is simply not
// initialised — the callables then refuse every request, which is the
// intended fail-closed posture until the key is configured (DEPLOYMENT.md).
//
// Local development against the real project uses a DEBUG token registered
// in the console (VITE_FIREBASE_APPCHECK_DEBUG_TOKEN, dev builds only). It is
// never armed when the callables are on the local Functions emulator: the SDK
// puts debug mode AHEAD of any provider and exchanges the debug token with the
// REAL App Check service, where the emulator project has no registered app.
const appCheckSiteKey = import.meta.env.VITE_FIREBASE_APPCHECK_SITE_KEY
if (import.meta.env.DEV && import.meta.env.VITE_FIREBASE_APPCHECK_DEBUG_TOKEN && !useFunctionsEmulator) {
  self.FIREBASE_APPCHECK_DEBUG_TOKEN = import.meta.env.VITE_FIREBASE_APPCHECK_DEBUG_TOKEN
}
export const appCheckConfigured = typeof appCheckSiteKey === 'string' && appCheckSiteKey.length > 0
if (appCheckConfigured && !useFunctionsEmulator) {
  initializeAppCheck(app, {
    provider: new ReCaptchaEnterpriseProvider(appCheckSiteKey),
    isTokenAutoRefreshEnabled: true,
  })
}

// ── App Check against the LOCAL Functions emulator (D3 #38) — EMULATOR ONLY ──
//
// WHY THIS EXISTS. The callables keep `enforceAppCheck: true` unconditionally,
// and the Functions emulator honours it: a v2 `onCall` request with no
// `X-Firebase-AppCheck` header is refused as `app: MISSING` before the handler
// runs (firebase-functions 7.4.0, lib/common/providers/https.js:339-343 and
// :489-491). What the emulator relaxes is only VERIFICATION: firebase-tools
// starts every emulated function with
// `FIREBASE_DEBUG_FEATURES={"skipTokenVerification":true}`
// (firebase-tools 15.34.2, lib/emulator/functionsEmulator.js:1019-1023), and
// under that flag the header is DECODED, never verified (https.js:346-351,
// `unsafeDecodeAppCheckToken`). So the browser must SEND a token; it need not
// be a genuine one. Without this block a tester had to inject one by hand.
//
// THE MECHANISM is `CustomProvider` from `firebase/app-check` — the supported
// API for supplying App Check tokens from your own source
// (https://firebase.google.com/docs/app-check/web/custom-provider). The
// provider below returns an UNSIGNED token (`alg: "none"`, empty signature),
// the same shape tests/functions/_harness.js mints for the automated suite.
//
// WHY NOT THE DEBUG PROVIDER (`self.FIREBASE_APPCHECK_DEBUG_TOKEN`,
// https://firebase.google.com/docs/app-check/web/debug-provider). A debug
// token must be registered in the Firebase console for a REAL project and is
// exchanged with the real App Check service
// (@firebase/app-check 0.12.0, dist/esm/index.esm.js:745-771). The emulator
// project has no such app: the exchange fails, the SDK returns a dummy token
// WITH an error, and the Functions client then sends NO header at all
// (@firebase/functions 0.13.5, dist/esm/index.esm.js:375-380) — the emulator
// refuses exactly as before. It would also mean a real network call to Google
// from an otherwise fully local stack, and a console-registered credential.
//
// WHY THIS IS NOT A PRODUCTION BYPASS — three independent reasons:
//   1. Reachable only under `useFunctionsEmulator`, i.e. every emulator
//      condition (DEV, MODE === 'emulator', the launcher's child-process
//      flags) AND Functions being the emulator. `import.meta.env.DEV` is the
//      literal `false` in `vite build`, so the whole block is dead code and is
//      removed from the bundle (pinned by tests/unit/emulatorAppCheck.test.js;
//      the marker string below must not appear in `dist/`).
//   2. The token is unsigned. Production verifies the RS256 signature against
//      the App Check JWKS (firebase-admin 14.5.0,
//      lib/app-check/token-verifier.js:104 rejects any other `alg`), so this
//      token is refused everywhere except a verification-skipping emulator.
//   3. Nothing server-side changed: `enforceAppCheck: true` stays on every
//      callable, with no environment switch.
// No credential is involved: nothing here is secret, registered or reusable.
const EMULATOR_APP_CHECK_ISSUER = 'constrap-local-emulator-unsigned-app-check'
if (useFunctionsEmulator) {
  const b64url = (o) => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  const TTL_SECONDS = 3600
  initializeAppCheck(app, {
    provider: new CustomProvider({
      getToken: async () => {
        const now = Math.floor(Date.now() / 1000)
        const payload = {
          iss: EMULATOR_APP_CHECK_ISSUER,
          sub: firebaseConfig.appId,
          aud: [`projects/${firebaseConfig.projectId}`],
          iat: now,
          exp: now + TTL_SECONDS,
        }
        return {
          token: `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url(payload)}.`,
          expireTimeMillis: (now + TTL_SECONDS) * 1000,
        }
      },
    }),
    isTokenAutoRefreshEnabled: true,
  })
}

export const auth    = getAuth(app)
export const db      = getFirestore(app)
export const storage = getStorage(app)

// The trusted backend's ONE region (functions/src/lib/params.js → REGION).
// Callables are addressed by region; a mismatch is a 404, not a fallback.
export const FUNCTIONS_REGION = 'australia-southeast1'
export const functions = getFunctions(app, FUNCTIONS_REGION)

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
//
// (`useFirestoreEmulator` itself is declared near the top of this file, next
// to `initializeApp`, because the App Check block needs the emulator flags.)
if (useFirestoreEmulator) {
  const host = import.meta.env.VITE_FIRESTORE_EMULATOR_HOST || '127.0.0.1'
  const port = Number(import.meta.env.VITE_FIRESTORE_EMULATOR_PORT || 8080)
  connectFirestoreEmulator(db, host, port)
  // Loud on purpose — nobody should ever be unsure which datastore they are
  // looking at while doing manual financial acceptance.
  console.warn(
    `%c[Constrap] FIRESTORE → LOCAL EMULATOR ${host}:${port} (project "${firebaseConfig.projectId}") — data is disposable and NOT production. Auth is real.`,
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
    `%c[Constrap] STORAGE → LOCAL EMULATOR ${host}:${port} (bucket "${firebaseConfig.storageBucket}") — files are disposable and NOT production.`,
    'background:#F5A623;color:#000;font-weight:bold;padding:2px 6px;border-radius:3px',
  )
}

// ── Local Functions + Auth emulators — LAUNCHER-ONLY, and only WITH Firestore ─
//
// The team-management launcher (`npm run test:team`, scripts/team-dev.mjs)
// points the callables at the Functions emulator and — because invitation
// acceptance creates Auth accounts — Auth at the Auth emulator too. Both
// require every Firestore condition above PLUS their own explicit opt-in, so
// no older launcher changes behaviour. Functions is never emulated against
// production Auth or Firestore: the backend's Admin SDK would then write real
// membership documents from a throwaway function, the one split this file
// exists to prevent.
//
// (`useFunctionsEmulator` is declared near the top of this file: Firestore
// emulator conditions AND VITE_USE_FUNCTIONS_EMULATOR AND VITE_USE_AUTH_EMULATOR.)
// App Check for this mode is the unsigned emulator-only provider above.
if (useFunctionsEmulator) {
  const host = import.meta.env.VITE_FIRESTORE_EMULATOR_HOST || '127.0.0.1'
  const fnPort = Number(import.meta.env.VITE_FUNCTIONS_EMULATOR_PORT || 5001)
  const authPort = Number(import.meta.env.VITE_AUTH_EMULATOR_PORT || 9099)
  connectAuthEmulator(auth, `http://${host}:${authPort}`, { disableWarnings: true })
  connectFunctionsEmulator(functions, host, fnPort)
  console.warn(
    `%c[Constrap] AUTH → ${host}:${authPort}, FUNCTIONS → ${host}:${fnPort} (LOCAL EMULATORS) — accounts and invitations are disposable and NOT production. App Check: unsigned emulator-only token.`,
    'background:#F5A623;color:#000;font-weight:bold;padding:2px 6px;border-radius:3px',
  )
}
