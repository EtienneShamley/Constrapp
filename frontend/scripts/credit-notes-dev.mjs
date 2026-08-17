// ─────────────────────────────────────────────────────────────────────────────
// DEVELOPMENT-ONLY one-command launcher for manual Credit Notes testing.
//
//     npm run test:credit-notes
//
// Starts the Firestore emulator, waits for it, seeds the Credit Notes fixture,
// and starts Vite pointed at the emulator — then prints where to open the app.
// Ctrl+C stops everything.
//
// PRODUCTION IS UNREACHABLE FROM HERE, by construction:
//   · `firebase emulators:exec` sets FIRESTORE_EMULATOR_HOST for its child, and
//     seed-emulator.mjs REFUSES to run without it (and refuses a non-loopback
//     host, and refuses if GOOGLE_APPLICATION_CREDENTIALS is set). Every one of
//     those safeguards is untouched by this launcher.
//   · VITE_USE_FIREBASE_EMULATOR is set for the CHILD PROCESS ONLY. No file is
//     written, so `npm run dev` keeps whatever behaviour .env.local gives it.
//   · The app's own guard (src/lib/firebase.js) additionally requires
//     import.meta.env.DEV AND `--mode emulator` (passed to Vite below), so no
//     production build — and no plain `npm run dev` — can ever connect to it.
//
// Uses only what is already installed: firebase-tools (devDependency) and Vite.
// ─────────────────────────────────────────────────────────────────────────────

import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const FRONTEND = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// Vite's default is 5173; use a distinct port so this can run alongside an
// ordinary `npm run dev`. Not strict — if it is taken Vite picks the next free
// port, and the real URL is read back from Vite's own output below.
const VITE_PORT = process.env.CREDIT_NOTES_PORT || '5174'

const die = (lines) => {
  console.error(`\n✖ ${lines.join('\n  ')}\n`)
  process.exit(1)
}

// ── Preflight: the app cannot sign in without Firebase config ────────────────
// Auth is NOT emulated — testers authenticate against the real Firebase Auth
// project — so a missing .env.local produces a confusing blank login rather
// than an obvious error. Catch it here, in plain language.
const envPath = resolve(FRONTEND, '.env.local')
if (!existsSync(envPath)) {
  die([
    'frontend/.env.local is missing.',
    '',
    'Copy frontend/.env.example to frontend/.env.local and fill in the Firebase',
    'values from the Firebase console (Project settings → Your apps → Web app).',
  ])
}
const envText = readFileSync(envPath, 'utf8')
const readEnv = (key) => {
  const m = envText.match(new RegExp(`^\\s*${key}\\s*=\\s*(.+)\\s*$`, 'm'))
  return m ? m[1].trim().replace(/^["']|["']$/g, '') : ''
}
const missing = ['VITE_FIREBASE_API_KEY', 'VITE_FIREBASE_AUTH_DOMAIN', 'VITE_FIREBASE_PROJECT_ID']
  .filter(key => !readEnv(key))
if (missing.length) {
  die([
    `frontend/.env.local is missing: ${missing.join(', ')}`,
    '',
    'Fill those in from the Firebase console (Project settings → Your apps → Web app).',
  ])
}

// The emulator namespaces data BY PROJECT ID, and the app connects using this
// same value — seeding under any other id would write data the app cannot see.
const PROJECT_ID = readEnv('VITE_FIREBASE_PROJECT_ID')

// ── Resolve the firebase CLI without requiring a global install ──────────────
const localBin = resolve(FRONTEND, 'node_modules/.bin', process.platform === 'win32' ? 'firebase.cmd' : 'firebase')
const useLocalBin = existsSync(localBin)
if (!useLocalBin && !existsSync(resolve(FRONTEND, 'node_modules'))) {
  die(['frontend/node_modules is missing. Run `npm install` in frontend/ first.'])
}

// `emulators:exec` runs this command with FIRESTORE_EMULATOR_HOST already set,
// then shuts the emulator down when the command exits — which is what makes
// Ctrl+C clean up both processes.
// `--mode emulator` is the tamper-proof half of the gate in src/lib/firebase.js:
// a `.env` file can set VITE_USE_FIREBASE_EMULATOR but can never set MODE, so
// only a launcher can satisfy all three conditions.
const inner = `node scripts/seed-emulator.mjs && vite --mode emulator --port ${VITE_PORT}`

const TESTER_UID = (process.env.TEST_USER_UID ?? '').trim()

console.log(`
────────────────────────────────────────────────────────────
 Credit Notes manual test environment
────────────────────────────────────────────────────────────
 Firebase project : ${PROJECT_ID} (LOCAL EMULATOR — not production)
 Tester UID       : ${TESTER_UID || 'Etienne (default) — set TEST_USER_UID to add your own'}

 Starting the Firestore emulator, seeding test data, then Vite.
 This takes a few seconds. Press Ctrl+C to stop everything.
────────────────────────────────────────────────────────────
`)

const child = spawn(
  useLocalBin ? localBin : 'npx',
  [
    ...(useLocalBin ? [] : ['firebase']),
    'emulators:exec', '--only', 'firestore', '--project', PROJECT_ID, inner,
  ],
  {
    cwd: FRONTEND,
    // Set for the CHILD ONLY — no file is modified, so `npm run dev` is untouched.
    env: { ...process.env, VITE_USE_FIREBASE_EMULATOR: 'true', BROWSER: 'none' },
    stdio: ['inherit', 'pipe', 'pipe'],
    shell: !useLocalBin,
    // POSIX: put the emulator, its shell, and Vite in their OWN process group
    // so shutdown can signal all three at once. Without this, stopping the
    // launcher can leave Vite running and holding the port, which makes the
    // next run fail for reasons a non-technical tester cannot diagnose.
    // Windows has no equivalent; there the shell handles the tree.
    detached: process.platform !== 'win32',
  },
)

// ── Forward all output, and announce readiness when Vite says it is ready ────
// Vite colourises its output, so strip ANSI escapes before matching — the codes
// sit INSIDE the URL (between host and port) and would break a naive regex.
const STRIP_ANSI = /\[[0-9;]*m/g
let announced = false

function watch(chunk, stream) {
  stream.write(chunk)
  if (announced) return
  const text = chunk.toString().replace(STRIP_ANSI, '')
  const match = text.match(/Local:\s+(https?:\/\/\S+?)\/?\s*$/m)
  if (!match) return
  announced = true
  const url = match[1]
  console.log(`
────────────────────────────────────────────────────────────
 Credit Notes manual test environment ready

 Open: ${url}

 Sign in with your normal Constrapp account. Then open
 "Credit Notes Test Project" → Supplier Invoices:
   SI-0001  posted, no retention   → Record credit note works
   SI-0002  posted, retention held → credit notes are blocked

 Data is throwaway and disappears when you press Ctrl+C.
────────────────────────────────────────────────────────────
`)
}

child.stdout.on('data', (c) => watch(c, process.stdout))
child.stderr.on('data', (c) => watch(c, process.stderr))

// ── Clean shutdown ───────────────────────────────────────────────────────────
// Ctrl+C reaches the child via the foreground process group, but forward it
// explicitly so the emulator is always given the chance to shut down tidily.
let stopping = false

// Signals the whole child process group (emulator + shell + Vite), falling back
// to the single child if the group has already gone.
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
    console.log('\n⏹  Stopping Vite and the Firestore emulator…')
    stopChild('SIGINT')
    // The emulator needs a moment to flush and release its port. If anything is
    // still alive after that, take it down hard rather than leave a stale
    // process holding 8080 or the Vite port.
    setTimeout(() => stopChild('SIGKILL'), 8000).unref()
  })
}

child.on('error', (err) => {
  die([`Could not start the Firebase emulator: ${err.message}`])
})

child.on('exit', (code) => {
  console.log(stopping
    ? '✔ Stopped. Emulator data has been discarded.\n'
    : `\nEmulator session ended (exit code ${code ?? 0}).\n`)
  process.exit(code ?? 0)
})
