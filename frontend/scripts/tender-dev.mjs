// ── Tender local acceptance launcher ─────────────────────────────────────────
//
//   npm run test:tender
//
// One command: starts a local Firestore emulator, seeds the deterministic
// Tender acceptance fixtures, and serves the app against that emulator. Ctrl+C
// tears the whole thing down and the emulator's data is discarded.
//
// WHAT IS AND IS NOT LOCAL
//   · Firestore  → EMULATED (localhost, ephemeral, seeded)
//   · Auth       → REAL. You sign in with your real account, which is why the
//                  seed writes a profile for your real uid.
//   · Storage    → untouched (the app initialises it but Tender uses none)
//
// SAFETY. The app only redirects Firestore when all three of these hold:
// DEV build + `--mode emulator` + VITE_USE_FIREBASE_EMULATOR=true, and the last
// is injected into the Vite child env here — never into .env.local. `npm run
// dev` cannot satisfy the mode condition, so it stays pointed at the real
// project no matter what any .env file says. The project id is additionally
// overridden to a `demo-` id for this process only: even a mis-wired emulator
// connection could not reach a real Firebase project, because no such project
// exists. .env.local is READ BY NOBODY HERE and is never modified.

import { spawn } from 'node:child_process'
import { createServer as createNetServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const FRONTEND = resolve(HERE, '..')

const EMULATOR_HOST = '127.0.0.1'
const EMULATOR_PORT = 8080                      // matches frontend/firebase.json
const PROJECT_ID    = 'demo-tender-acceptance'  // `demo-` = never a real project
const PREFERRED_PORT = 5174                     // `npm run dev` keeps 5173

const DEFAULT_UID = 'igCEJR3XzdTd5JEIJSC5QyP5eBB3'

const c = {
  dim:   (s) => `\x1b[2m${s}\x1b[0m`,
  bold:  (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  amber: (s) => `\x1b[33m${s}\x1b[0m`,
  red:   (s) => `\x1b[31m${s}\x1b[0m`,
  cyan:  (s) => `\x1b[36m${s}\x1b[0m`,
}

const log  = (s = '') => console.log(s)
const step = (s) => console.log(c.cyan(`▸ ${s}`))
const fail = (s) => console.error(c.red(`✖ ${s}`))

// ── Guards ───────────────────────────────────────────────────────────────────

if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  fail('GOOGLE_APPLICATION_CREDENTIALS is set. Refusing to start an acceptance environment')
  fail('while service-account credentials are in scope. Unset it and re-run.')
  process.exit(1)
}

const portFree = (port, host) => new Promise((res) => {
  const s = createNetServer()
  s.once('error', () => res(false))
  s.once('listening', () => s.close(() => res(true)))
  s.listen(port, host)
})

const firstFreePort = async (start, host = '127.0.0.1') => {
  for (let p = start; p < start + 20; p++) if (await portFree(p, host)) return p
  throw new Error(`no free port between ${start} and ${start + 19}`)
}

// ── Child process bookkeeping ────────────────────────────────────────────────

let emulator = null
let viteServer = null
let shuttingDown = false

async function shutdown(code = 0, reason = '') {
  if (shuttingDown) return
  shuttingDown = true
  log()
  step(`Shutting down${reason ? ` (${reason})` : ''}…`)

  if (viteServer) {
    try { await viteServer.close(); log(c.dim('   vite server closed')) }
    catch { /* already gone */ }
  }

  if (emulator && emulator.pid && emulator.exitCode === null) {
    // The emulator was spawned detached, so it owns a process GROUP: the
    // firebase CLI plus the Java emulator it forks. Signalling the negative pid
    // reaches every member, which is what stops a Java process outliving us and
    // holding port 8080.
    const killGroup = (signal) => {
      try { process.kill(-emulator.pid, signal) }
      catch { try { emulator.kill(signal) } catch { /* gone */ } }
    }
    killGroup('SIGTERM')
    const stopped = await Promise.race([
      new Promise((res) => emulator.once('exit', () => res(true))),
      new Promise((res) => setTimeout(() => res(false), 8000)),
    ])
    if (!stopped) {
      log(c.dim('   emulator did not stop politely — sending SIGKILL'))
      killGroup('SIGKILL')
      await new Promise((res) => setTimeout(res, 500))
    }
    log(c.dim('   firestore emulator stopped (its data is discarded)'))
  }

  // Confirm the port really is free again, so "no stale processes" is a
  // verified statement rather than a hopeful one.
  const free = await portFree(EMULATOR_PORT, EMULATOR_HOST)
  log(free
    ? c.green(`   port ${EMULATOR_PORT} released`)
    : c.amber(`   ⚠ port ${EMULATOR_PORT} still busy — check for a stray emulator`))

  log(c.green('✔ Clean exit.'))
  process.exit(code)
}

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => { shutdown(0, sig) })
}
process.on('uncaughtException', (err) => { fail(err.message); shutdown(1, 'error') })

// ── Emulator ─────────────────────────────────────────────────────────────────

async function startEmulator() {
  if (!(await portFree(EMULATOR_PORT, EMULATOR_HOST))) {
    fail(`Port ${EMULATOR_PORT} is already in use.`)
    fail('Another Firestore emulator (or `npm run test:rules`) is probably running.')
    fail('Stop it and re-run — this launcher will not attach to an emulator it did not start.')
    process.exit(1)
  }

  step('Starting Firestore emulator (Firestore only — Auth stays real)…')
  emulator = spawn(
    'npx',
    ['firebase', 'emulators:start', '--only', 'firestore', '--project', PROJECT_ID],
    { cwd: FRONTEND, detached: true, stdio: ['ignore', 'pipe', 'pipe'] },
  )

  let emulatorLog = ''
  emulator.stdout.on('data', (d) => { emulatorLog += d.toString() })
  emulator.stderr.on('data', (d) => { emulatorLog += d.toString() })
  emulator.on('exit', (code) => {
    if (!shuttingDown) {
      fail(`Firestore emulator exited unexpectedly (code ${code}).`)
      log(c.dim(emulatorLog.split('\n').slice(-25).join('\n')))
      shutdown(1, 'emulator died')
    }
  })

  // Ready when the emulator answers HTTP. A JDK is required (same prerequisite
  // as `npm run test:rules`).
  const deadline = Date.now() + 90_000
  for (;;) {
    if (Date.now() > deadline) {
      fail('Firestore emulator did not become ready within 90s.')
      log(c.dim(emulatorLog.split('\n').slice(-25).join('\n')))
      log(c.amber('A JDK is required for the Firestore emulator (same as `npm run test:rules`).'))
      await shutdown(1, 'emulator timeout')
      return
    }
    try {
      const res = await fetch(`http://${EMULATOR_HOST}:${EMULATOR_PORT}/`)
      if (res.ok || res.status === 200) break
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300))
  }
  log(c.green(`   emulator ready on ${EMULATOR_HOST}:${EMULATOR_PORT}`))
}

// ── Seed ─────────────────────────────────────────────────────────────────────

async function seedFixtures(uids) {
  step('Seeding Tender acceptance fixtures…')
  // The seed runs in a CHILD process whose env carries the emulator host. Its
  // own safety gate re-checks that host independently, so the seed can never
  // be tricked into writing anywhere else.
  await new Promise((res, rej) => {
    const child = spawn(process.execPath, [resolve(HERE, 'seed-tender-emulator.mjs')], {
      cwd: FRONTEND,
      stdio: ['ignore', 'inherit', 'inherit'],
      env: {
        ...process.env,
        FIRESTORE_EMULATOR_HOST: `${EMULATOR_HOST}:${EMULATOR_PORT}`,
        TENDER_EMULATOR_PROJECT_ID: PROJECT_ID,
        TEST_USER_UID: uids[1] ?? '',
        GOOGLE_APPLICATION_CREDENTIALS: '',
      },
    })
    child.on('exit', (code) => (code === 0 ? res() : rej(new Error(`seed exited with code ${code}`))))
  })
  log(c.green('   fixtures seeded'))
}

// ── Vite ─────────────────────────────────────────────────────────────────────

async function startVite() {
  const port = await firstFreePort(PREFERRED_PORT)
  step(`Starting Vite in emulator mode on port ${port}…`)

  // These three are what unlock the emulator branch in src/lib/firebase.js.
  // They live in THIS PROCESS ONLY — nothing is written to any .env file, so
  // `npm run dev` in another terminal is completely unaffected.
  process.env.VITE_USE_FIREBASE_EMULATOR = 'true'
  process.env.VITE_FIRESTORE_EMULATOR_HOST = EMULATOR_HOST
  process.env.VITE_FIRESTORE_EMULATOR_PORT = String(EMULATOR_PORT)
  // Vite gives process.env precedence over .env files for VITE_-prefixed keys,
  // so this overrides the real project id without touching .env.local.
  process.env.VITE_FIREBASE_PROJECT_ID = PROJECT_ID

  const { createServer } = await import('vite')
  viteServer = await createServer({
    root: FRONTEND,
    mode: 'emulator',
    configFile: resolve(FRONTEND, 'vite.config.js'),
    server: { port, strictPort: true, open: false },
  })
  await viteServer.listen()
  return viteServer.resolvedUrls?.local?.[0] ?? `http://localhost:${port}/`
}

// ── Run ──────────────────────────────────────────────────────────────────────

async function main() {
  const uids = [DEFAULT_UID]
  const extra = process.env.TEST_USER_UID?.trim()
  if (extra && extra !== DEFAULT_UID) uids.push(extra)

  log()
  log(c.bold('  Constrapp — Tender Foundation local acceptance environment'))
  log(c.dim('  Firestore: EMULATED (ephemeral)   Auth: REAL   Production data: untouched'))
  log()

  await startEmulator()
  await seedFixtures(uids)
  const url = await startVite()

  log()
  log(c.green('  ─────────────────────────────────────────────────────────────'))
  log(c.bold(`  OPEN:  ${c.cyan(url)}`))
  log(c.green('  ─────────────────────────────────────────────────────────────'))
  log()
  log(c.bold('  Sign in with your REAL account (auth is not emulated).'))
  log('  Seeded company_admin uid(s):')
  for (const [i, uid] of uids.entries()) {
    log(`    · ${uid}${i === 0 ? c.dim('  (default — Etienne)') : c.dim('  (TEST_USER_UID)')}`)
  }
  log(`  Company: ${COMPANY_LABEL()}`)
  log()
  log(c.bold('  Three projects, three jobs:'))
  log(`    1. ${c.bold('Tender Currency Test Project')}`)
  log(c.dim('       No monetary records at all. Create a package (currency must STAY unlocked),'))
  log(c.dim('       issue it, then record the FIRST bid — the currency must lock, citing "1 tender bid".'))
  log(`    2. ${c.bold('Tender Comparison Test Project')}`)
  log(c.dim('       Approved Budget $20,000 (0300 $12,000 + 0400 $8,000). Enter the package and the'))
  log(c.dim('       three bids by hand; your package should number TP-0001. Expect BuildCo and Metro'))
  log(c.dim('       tied LOWEST at $16,000 (+$4,000 under budget) and Prime $17,500 (+$2,500 under,'))
  log(c.dim('       +$1,500 to lowest) — proving Budget − Bid and tie handling.'))
  log(`    3. ${c.bold('Tender Malformed Bid Test Project')}`)
  log(c.dim('       Pre-seeded fail-safe fixtures (TP-9001 issued, TP-9002 already awarded).'))
  log(c.dim('       TP-9001 holds a malformed bid beside a valid $27,000 one: the malformed bid must'))
  log(c.dim('       read Invalid, carry no total, stay out of the lowest-bid maths, and be unawardable.'))
  log(c.dim('       TP-9002 was awarded to a malformed bid: its Awarded Bid Value must read'))
  log(c.dim('       "unavailable" — never $0, NaN, Infinity, or an invented number.'))
  log()
  log(c.dim('  Everything you click is evaluated against the real frontend/firestore.rules.'))
  log(c.dim('  Only the seed bypassed them, exactly as the automated rules suites do.'))
  log()
  log(c.amber('  Ctrl+C stops Vite and the emulator and discards all emulator data.'))
  log()
}

const COMPANY_LABEL = () => 'Apex Builders (2Vf3CVuYE8wWzg8hLjR5)'

main().catch(async (err) => {
  fail(err.message)
  await shutdown(1, 'startup failed')
})
