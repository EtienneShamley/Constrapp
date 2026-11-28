#!/usr/bin/env node
// ── Team-management manual-acceptance launcher (ADR-72) ──────────────────────
//
//   npm run test:team
//
// One command that starts the Auth, Firestore AND Functions emulators,
// bootstraps a disposable company with an operator-delivered Company Admin
// invitation (the bootstrap writes its link to a private temporary file —
// it never prints it; this launcher reads that EMULATOR-ONLY link back and
// shows it, then deletes the file), then starts Vite with the
// emulator opt-ins set FOR THAT CHILD PROCESS ONLY:
//
//   VITE_USE_FIREBASE_EMULATOR=true  VITE_USE_AUTH_EMULATOR=true
//   VITE_USE_FUNCTIONS_EMULATOR=true vite --mode emulator
//
// Everything is in-memory and discarded on exit. Auth IS emulated here
// (unlike the older launchers) because acceptance creates accounts; the
// trusted backend's Admin SDK must never write real membership from a
// throwaway function. No production credential is read.

import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { prepareIsolation, TEST_PROJECT_ID } from './emulatorIsolation.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const FRONTEND = resolve(HERE, '..')
const HOST = '127.0.0.1'
const PROJECT_ID = TEST_PROJECT_ID   // the ONE emulator project (a demo- project); never production
const VITE_PORTS = [5173, 5174, 5175, 5176]

const c = { dim: (s) => `\x1b[2m${s}\x1b[0m`, bold: (s) => `\x1b[1m${s}\x1b[0m`, green: (s) => `\x1b[32m${s}\x1b[0m`, red: (s) => `\x1b[31m${s}\x1b[0m`, cyan: (s) => `\x1b[36m${s}\x1b[0m` }
const children = []
let shuttingDown = false

function fail(msg) { console.error(`\n${c.red('✖')} ${msg}\n`); process.exit(1) }

function portFree(port) {
  return new Promise((res) => {
    const s = createServer()
    s.once('error', () => res(false))
    s.once('listening', () => s.close(() => res(true)))
    s.listen(port, HOST)
  })
}

// Bounded readiness: poll `probe` (a real request to the service, not a
// fixed sleep) every 300 ms until it answers true or the deadline passes.
const READY_TIMEOUT_MS = 120_000
async function waitUntil(probe, deadline) {
  while (Date.now() < deadline && !shuttingDown) {
    try { if (await probe()) return true } catch { /* not listening yet */ }
    await sleep(300)
  }
  return false
}
const answers = (path, ok = (r) => r.ok) => async (port) => ok(await fetch(`http://${HOST}:${port}${path}`, { signal: AbortSignal.timeout(2000) }))
// Each emulator's own readiness endpoint. Auth answers its project config only
// once it serves requests (the bootstrap's first Auth lookup needs it);
// Firestore answers "Ok" on /; the Functions emulator answers on / once bound.
const PROBES = {
  auth: answers(`/emulator/v1/projects/${PROJECT_ID}/config`),
  firestore: answers('/'),
  functions: answers('/', (r) => r.status > 0),
  storage: answers('/', (r) => r.status > 0),
}

// `--storage` (local acceptance of drawings / Quant only): also start the
// Storage emulator and point the app at it. Same isolation, same demo project.
const WITH_STORAGE = process.argv.includes('--storage')

function spawnGroup(cmd, args, opts = {}) {
  const child = spawn(cmd, args, { cwd: FRONTEND, detached: true, stdio: ['ignore', 'pipe', 'pipe'], ...opts })
  children.push(child)
  return child
}

function killGroup(child, signal) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  try { process.kill(-child.pid, signal) } catch { try { child.kill(signal) } catch { /* gone */ } }
}

async function shutdown(code = 0) {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`\n${c.dim('Shutting down Vite and the emulators…')}`)
  for (const ch of children) killGroup(ch, 'SIGTERM')
  // Wait for the children to exit (bounded), then force any that remain.
  const exited = (ch) => ch.exitCode !== null || ch.signalCode !== null
  const until = Date.now() + 10_000
  while (Date.now() < until && !children.every(exited)) await sleep(200)
  for (const ch of children) killGroup(ch, 'SIGKILL')
  console.log(c.dim('Stopped. Emulator data was in-memory and is now discarded.'))
  process.exit(code)
}

async function main() {
  // The emulators, the Functions runtime and the bootstrap script run in an
  // ISOLATED environment that holds no credential file, no CLI sign-in and no
  // credential variable (scripts/emulatorIsolation.mjs; tracker D3 #17).
  let isolation
  try { isolation = prepareIsolation() } catch (err) { fail(err.message) }
  const firebaseBin = resolve(FRONTEND, 'node_modules/.bin/firebase')
  const viteBin = resolve(FRONTEND, 'node_modules/.bin/vite')
  if (!existsSync(firebaseBin) || !existsSync(viteBin)) fail('Run `npm install` in frontend/ first.')
  if (!existsSync(resolve(FRONTEND, 'functions/node_modules'))) fail('Run `npm install` in frontend/functions/ first.')

  const emu = JSON.parse(readFileSync(resolve(FRONTEND, 'firebase.json'), 'utf8')).emulators
  const ports = { firestore: emu.firestore.port, auth: emu.auth.port, functions: emu.functions.port, ...(WITH_STORAGE ? { storage: emu.storage.port } : {}) }
  for (const [name, port] of Object.entries(ports)) if (!(await portFree(port))) fail(`Port ${port} (${name}) is in use — another emulator is probably running.`)
  let vitePort = null
  for (const p of VITE_PORTS) if (await portFree(p)) { vitePort = p; break }
  if (!vitePort) fail(`No free Vite port among ${VITE_PORTS.join(', ')}.`)

  const adminEmail = (process.env.TEAM_ADMIN_EMAIL || 'admin@example.test').trim()
  // The same loopback address Vite binds to (--host below) and the launcher
  // probes: `localhost` can resolve to ::1 only, which the probe would miss.
  const appBaseUrl = `http://${HOST}:${vitePort}`

  console.log(`\n${c.bold('Team management — manual acceptance')} ${c.dim(`· emulator project ${PROJECT_ID}`)}`)
  console.log(c.dim('─'.repeat(64)))

  process.stdout.write(`  ${c.dim('1/3')} Starting Auth, Firestore and Functions emulators… `)
  const emulator = spawnGroup(firebaseBin, ['emulators:start', '--only', WITH_STORAGE ? 'auth,firestore,functions,storage' : 'auth,firestore,functions', '--project', PROJECT_ID], { env: isolation.env })
  let log = ''
  emulator.stdout.on('data', (d) => { log += d.toString() })
  emulator.stderr.on('data', (d) => { log += d.toString() })
  emulator.on('exit', (code) => { if (!shuttingDown) { console.error(`\n${c.red('✖')} The emulators exited (code ${code}).`); console.error(c.dim(log.split('\n').slice(-30).join('\n'))); shutdown(1) } })
  // All three services, and the CLI's own "ready" signal (Functions loaded),
  // before anything talks to them — one bounded deadline for the lot.
  const deadline = Date.now() + READY_TIMEOUT_MS
  const notReady = []
  for (const name of ['auth', 'firestore', 'functions', ...(WITH_STORAGE ? ['storage'] : [])]) {
    if (!(await waitUntil(() => PROBES[name](ports[name]), deadline))) notReady.push(name)
  }
  if (notReady.length === 0 && !(await waitUntil(async () => log.includes('All emulators ready'), deadline))) notReady.push('emulator hub')
  if (notReady.length > 0) { console.log(c.red(`failed — not ready within ${READY_TIMEOUT_MS / 1000} s: ${notReady.join(', ')}`)); console.error(c.dim(log.split('\n').slice(-30).join('\n'))); await shutdown(1); return }
  console.log(c.green('ready'))

  process.stdout.write(`  ${c.dim('2/3')} Bootstrapping a company and its first admin… `)
  const linkDir = mkdtempSync(join(tmpdir(), 'constrap-team-dev-'))   // 0700, outside the repository
  const linkFile = join(linkDir, 'admin-link.txt')
  const boot = spawn(process.execPath, [
    resolve(FRONTEND, 'functions/scripts/bootstrap-company.mjs'),
    '--project', PROJECT_ID, '--company-id', 'demo-builders', '--company-name', 'Demo Builders',
    '--admin-email', adminEmail, '--country', 'AU', '--currency', 'AUD', '--app-url', appBaseUrl,
    '--apply', '--link-file', linkFile,
  ], {
    cwd: resolve(FRONTEND, 'functions'),
    env: { ...isolation.env, GCLOUD_PROJECT: PROJECT_ID, FIRESTORE_EMULATOR_HOST: `${HOST}:${ports.firestore}`, FIREBASE_AUTH_EMULATOR_HOST: `${HOST}:${ports.auth}` },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let bootOut = ''
  boot.stdout.on('data', (d) => { bootOut += d.toString() })
  boot.stderr.on('data', (d) => { bootOut += d.toString() })
  const bootCode = await new Promise((r) => boot.on('exit', r))
  let link = null
  try { if (bootCode === 0) link = readFileSync(linkFile, 'utf8').trim() } catch { /* reported below */ }
  rmSync(linkDir, { recursive: true, force: true })
  if (bootCode !== 0) { console.log(c.red('failed')); console.error(bootOut); await shutdown(1); return }
  console.log(c.green('done'))

  process.stdout.write(`  ${c.dim('3/3')} Starting Vite on ${HOST}:${vitePort}… `)
  // Loopback only, IPv4 — exactly the address probed below and used for links.
  const vite = spawnGroup(viteBin, ['--mode', 'emulator', '--host', HOST, '--port', String(vitePort), '--strictPort'], {
    env: {
      ...process.env,
      VITE_USE_FIREBASE_EMULATOR: 'true',
      VITE_USE_AUTH_EMULATOR: 'true',
      VITE_USE_FUNCTIONS_EMULATOR: 'true',
      VITE_FIRESTORE_EMULATOR_HOST: HOST,
      VITE_FIRESTORE_EMULATOR_PORT: String(ports.firestore),
      VITE_AUTH_EMULATOR_PORT: String(ports.auth),
      VITE_FUNCTIONS_EMULATOR_PORT: String(ports.functions),
      ...(WITH_STORAGE ? { VITE_USE_STORAGE_EMULATOR: 'true', VITE_STORAGE_EMULATOR_HOST: HOST, VITE_STORAGE_EMULATOR_PORT: String(ports.storage) } : {}),
      VITE_FIREBASE_PROJECT_ID: PROJECT_ID,
      VITE_FIREBASE_API_KEY: 'emulator',
      VITE_FIREBASE_APP_ID: '1:1:web:emulator',
      VITE_FIREBASE_AUTH_DOMAIN: `${PROJECT_ID}.firebaseapp.com`,
      VITE_FIREBASE_STORAGE_BUCKET: `${PROJECT_ID}.appspot.com`,
      VITE_FIREBASE_MESSAGING_SENDER_ID: '1',
      // App Check in this stack is the browser's unsigned EMULATOR-ONLY token
      // (src/lib/firebase.js). Blank both real-project inputs so a value left
      // in .env.local can neither start reCAPTCHA nor arm the debug provider.
      VITE_FIREBASE_APPCHECK_SITE_KEY: '',
      VITE_FIREBASE_APPCHECK_DEBUG_TOKEN: '',
    },
  })
  vite.stdout.on('data', () => {})
  vite.stderr.on('data', (d) => process.stderr.write(d))
  vite.on('exit', (code) => { if (!shuttingDown) { console.error(`\n${c.red('✖')} Vite exited (code ${code}).`); shutdown(1) } })
  if (!(await waitUntil(() => answers('/')(vitePort), Date.now() + READY_TIMEOUT_MS))) { console.log(c.red(`failed — not reachable on ${HOST}:${vitePort}`)); await shutdown(1); return }
  console.log(c.green('ready'))

  console.log(`\n  ${c.bold('Open the Company Admin acceptance link:')}`)
  console.log(`  ${c.cyan(link ?? '(link file not written — see bootstrap output above)')}`)
  console.log(`\n  ${c.dim('Register as')} ${adminEmail} ${c.dim('(any 12+ character password), then Company Settings → Team.')}`)
  console.log(`  ${c.dim('Invitation emails land in Firestore at companies/demo-builders/devOutbox/{inviteId} (field "link").')}`)
  console.log(`  ${c.dim('App Check stays ENFORCED on every callable here: the emulator requires a token but only decodes it (no')}`)
  console.log(`  ${c.dim('signature check), so this browser build sends an unsigned emulator-only token. Production verifies it.')}`)
  console.log(`\n  ${c.dim('Ctrl+C stops everything.')}\n`)
}

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))
main().catch((e) => fail(e?.message ?? String(e)))
