// ─────────────────────────────────────────────────────────────────────────────
// DEVELOPMENT-ONLY one-command launcher for manual Quant™ 1A acceptance.
//
//     npm run test:quant
//     TEST_USER_UID=<firebase-auth-uid> npm run test:quant
//     TEST_USER_ROLE=qs npm run test:quant
//
// Starts the Firestore AND Cloud Storage emulators, waits for both, seeds the
// Quant fixture (scripts/seed-quant-emulator.mjs — drawings with real PDF/PNG
// bytes and known dimensions), then starts Vite pointed at BOTH emulators and
// prints where to open the app. Ctrl+C stops everything and discards the data.
//
// PRODUCTION IS UNREACHABLE FROM HERE, by construction:
//   · `firebase emulators:exec --only firestore,storage` sets
//     FIRESTORE_EMULATOR_HOST and FIREBASE_STORAGE_EMULATOR_HOST for its child;
//     the seed REFUSES to run without both, refuses a non-loopback host,
//     refuses if GOOGLE_APPLICATION_CREDENTIALS is set, and PROBES both ports
//     before writing — so if either emulator is unavailable nothing starts.
//   · VITE_USE_FIREBASE_EMULATOR and VITE_USE_STORAGE_EMULATOR are set for the
//     CHILD PROCESS ONLY. No file is written, so `npm run dev` keeps whatever
//     behaviour .env.local gives it.
//   · The app's own guard (src/lib/firebase.js) additionally requires
//     import.meta.env.DEV AND `--mode emulator`, and never emulates Storage
//     without Firestore — so no production build, no plain `npm run dev`, and
//     none of the older launchers (`test:boq`, `test:tender`,
//     `test:credit-notes`, which set only the Firestore flag) can reach the
//     Storage emulator or change behaviour.
//   · Firebase Auth is NOT emulated (the supported arrangement): sign in with
//     your real Constrapp account; the seed writes membership for real UIDs.
//   · The browser console prints TWO orange banners — one per emulator — the
//     moment the app loads. If you do not see both, stop: you are not on the
//     disposable environment.
//
// Uses only what is already installed: firebase-tools (devDependency) and Vite.
// ─────────────────────────────────────────────────────────────────────────────

import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const FRONTEND = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// Distinct from Vite's default 5173 and from the other launchers' 5174, so this
// can run alongside them. Not strict — Vite picks the next free port if taken,
// and the real URL is read back from Vite's own output below.
const VITE_PORT = process.env.QUANT_PORT || '5178'

const die = (lines) => {
  console.error(`\n✖ ${lines.join('\n  ')}\n`)
  process.exit(1)
}

// ── Preflight: the app cannot sign in without Firebase config ────────────────
const envPath = resolve(FRONTEND, '.env.local')
if (!existsSync(envPath)) {
  die([
    'frontend/.env.local is missing.', '',
    'Copy frontend/.env.example to frontend/.env.local and fill in the Firebase',
    'values from the Firebase console (Project settings → Your apps → Web app).',
  ])
}
const envText = readFileSync(envPath, 'utf8')
const readEnv = (key) => {
  const m = envText.match(new RegExp(`^\\s*${key}\\s*=\\s*(.+)\\s*$`, 'm'))
  return m ? m[1].trim().replace(/^["']|["']$/g, '') : ''
}
const missing = ['VITE_FIREBASE_API_KEY', 'VITE_FIREBASE_AUTH_DOMAIN', 'VITE_FIREBASE_PROJECT_ID', 'VITE_FIREBASE_STORAGE_BUCKET']
  .filter(key => !readEnv(key))
if (missing.length) die([`frontend/.env.local is missing: ${missing.join(', ')}`])

const PROJECT_ID = readEnv('VITE_FIREBASE_PROJECT_ID')
const BUCKET = readEnv('VITE_FIREBASE_STORAGE_BUCKET')

// The emulator ports the app will be told about — read from firebase.json so
// the launcher, the emulators and the app can never disagree.
const firebaseJson = JSON.parse(readFileSync(resolve(FRONTEND, 'firebase.json'), 'utf8'))
const FIRESTORE_PORT = String(firebaseJson?.emulators?.firestore?.port ?? 8080)
const STORAGE_PORT = String(firebaseJson?.emulators?.storage?.port ?? 9199)

if (!existsSync(resolve(FRONTEND, 'tests/unit/fixtures/quant-two-page.pdf'))) {
  die(['tests/unit/fixtures/quant-two-page.pdf is missing — regenerate it with tests/unit/fixtures/make-quant-fixture.mjs.'])
}

// ── Resolve the firebase CLI without requiring a global install ──────────────
const localBin = resolve(FRONTEND, 'node_modules/.bin', process.platform === 'win32' ? 'firebase.cmd' : 'firebase')
const useLocalBin = existsSync(localBin)
if (!useLocalBin && !existsSync(resolve(FRONTEND, 'node_modules'))) {
  die(['frontend/node_modules is missing. Run `npm install` in frontend/ first.'])
}

// `emulators:exec` runs this with FIRESTORE_EMULATOR_HOST and
// FIREBASE_STORAGE_EMULATOR_HOST already set, then shuts both emulators down
// when the command exits. The seed refuses unless both are set and answering.
const inner = `node scripts/seed-quant-emulator.mjs && vite --mode emulator --port ${VITE_PORT}`

const TESTER_UID = (process.env.TEST_USER_UID ?? '').trim()
const TESTER_ROLE = (process.env.TEST_USER_ROLE ?? 'company_admin').trim()

console.log(`
────────────────────────────────────────────────────────────
 Quant™ 1A manual acceptance environment
────────────────────────────────────────────────────────────
 Firebase project : ${PROJECT_ID}  (LOCAL EMULATORS — not production)
 Firestore        : 127.0.0.1:${FIRESTORE_PORT}   DISPOSABLE
 Storage          : 127.0.0.1:${STORAGE_PORT}   DISPOSABLE  (bucket "${BUCKET}")
 Auth             : REAL Firebase Auth — sign in with your normal account
 Tester UID       : ${TESTER_UID || 'Etienne (default) — set TEST_USER_UID to add your own'}
 Tester role      : ${TESTER_ROLE}

 Starting both emulators, seeding drawings + files, then Vite.
 This takes a few seconds. Press Ctrl+C to stop everything.
────────────────────────────────────────────────────────────
`)

const child = spawn(
  useLocalBin ? localBin : 'npx',
  [
    ...(useLocalBin ? [] : ['firebase']),
    'emulators:exec', '--only', 'firestore,storage', '--project', PROJECT_ID, inner,
  ],
  {
    cwd: FRONTEND,
    // Set for the CHILD ONLY — no file is modified, so `npm run dev` is untouched.
    env: {
      ...process.env,
      VITE_USE_FIREBASE_EMULATOR: 'true',
      VITE_USE_STORAGE_EMULATOR: 'true',
      VITE_FIRESTORE_EMULATOR_HOST: '127.0.0.1',
      VITE_FIRESTORE_EMULATOR_PORT: FIRESTORE_PORT,
      VITE_STORAGE_EMULATOR_HOST: '127.0.0.1',
      VITE_STORAGE_EMULATOR_PORT: STORAGE_PORT,
      BROWSER: 'none',
    },
    stdio: ['inherit', 'pipe', 'pipe'],
    shell: !useLocalBin,
    // POSIX: own process group so shutdown signals emulators, shell and Vite at once.
    detached: process.platform !== 'win32',
  },
)

// ── Forward output and announce readiness when Vite says it is ready ─────────
const STRIP_ANSI = /\[[0-9;]*m/g
let announced = false

function watch(chunk, stream) {
  stream.write(chunk)
  if (announced) return
  const text = chunk.toString().replace(STRIP_ANSI, '')
  const match = text.match(/Local:\s+(https?:\/\/\S+?)\/?\s*$/m)
  if (!match) return
  announced = true
  console.log(`
────────────────────────────────────────────────────────────
 Quant™ 1A manual acceptance environment ready

 Open: ${match[1]}

 1. Open DevTools → Console FIRST and confirm BOTH orange banners:
      FIRESTORE → LOCAL EMULATOR 127.0.0.1:${FIRESTORE_PORT}
      STORAGE   → LOCAL EMULATOR 127.0.0.1:${STORAGE_PORT}
    No banners = not the disposable environment. Stop.
 2. Sign in with your normal Constrapp account.
 3. Open "Quant Takeoff Test Project" → Quant tab (TESTING.md §27).

 Firestore AND Storage data is throwaway and disappears on Ctrl+C.
────────────────────────────────────────────────────────────
`)
}

child.stdout.on('data', (c) => watch(c, process.stdout))
child.stderr.on('data', (c) => watch(c, process.stderr))

// ── Clean shutdown ───────────────────────────────────────────────────────────
let stopping = false
function stopChild(signal) {
  try {
    if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal)
    else child.kill(signal)
  } catch {
    try { child.kill(signal) } catch { /* already gone */ }
  }
}
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (stopping) return
    stopping = true
    console.log('\n⏹  Stopping Vite and both emulators…')
    stopChild('SIGINT')
    setTimeout(() => stopChild('SIGKILL'), 8000).unref()
  })
}
child.on('error', (err) => die([`Could not start the Firebase emulators: ${err.message}`]))
child.on('exit', (code) => {
  console.log(stopping
    ? '✔ Stopped. Firestore and Storage emulator data has been discarded.\n'
    : `\nEmulator session ended (exit code ${code ?? 0}).\n`)
  process.exit(code ?? 0)
})
