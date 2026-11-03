#!/usr/bin/env node
// ── Team-management manual-acceptance launcher (ADR-72) ──────────────────────
//
//   npm run test:team
//
// One command that starts the Auth, Firestore AND Functions emulators,
// bootstraps a disposable company with an operator-delivered Company Admin
// invitation (prints the acceptance link), then starts Vite with the
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
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const HERE = dirname(fileURLToPath(import.meta.url))
const FRONTEND = resolve(HERE, '..')
const HOST = '127.0.0.1'
const PROJECT_ID = 'constrapp-rules-test'   // the emulator project; never production
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

async function waitFor(port, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline && !shuttingDown) {
    try { const r = await fetch(`http://${HOST}:${port}/`); if (r.status > 0) return true } catch { /* not yet */ }
    await sleep(300)
  }
  return false
}

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
  await sleep(2500)
  for (const ch of children) killGroup(ch, 'SIGKILL')
  console.log(c.dim('Stopped. Emulator data was in-memory and is now discarded.'))
  process.exit(code)
}

async function main() {
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) fail('GOOGLE_APPLICATION_CREDENTIALS is set. Unset it before local emulator testing.')
  const firebaseBin = resolve(FRONTEND, 'node_modules/.bin/firebase')
  const viteBin = resolve(FRONTEND, 'node_modules/.bin/vite')
  if (!existsSync(firebaseBin) || !existsSync(viteBin)) fail('Run `npm install` in frontend/ first.')
  if (!existsSync(resolve(FRONTEND, 'functions/node_modules'))) fail('Run `npm install` in frontend/functions/ first.')

  const emu = JSON.parse(readFileSync(resolve(FRONTEND, 'firebase.json'), 'utf8')).emulators
  const ports = { firestore: emu.firestore.port, auth: emu.auth.port, functions: emu.functions.port }
  for (const [name, port] of Object.entries(ports)) if (!(await portFree(port))) fail(`Port ${port} (${name}) is in use — another emulator is probably running.`)
  let vitePort = null
  for (const p of VITE_PORTS) if (await portFree(p)) { vitePort = p; break }
  if (!vitePort) fail(`No free Vite port among ${VITE_PORTS.join(', ')}.`)

  const adminEmail = (process.env.TEAM_ADMIN_EMAIL || 'admin@example.test').trim()
  const appBaseUrl = `http://localhost:${vitePort}`

  console.log(`\n${c.bold('Team management — manual acceptance')} ${c.dim(`· emulator project ${PROJECT_ID}`)}`)
  console.log(c.dim('─'.repeat(64)))

  process.stdout.write(`  ${c.dim('1/3')} Starting Auth, Firestore and Functions emulators… `)
  const emulator = spawnGroup(firebaseBin, ['emulators:start', '--only', 'auth,firestore,functions', '--project', PROJECT_ID])
  let log = ''
  emulator.stdout.on('data', (d) => { log += d.toString() })
  emulator.stderr.on('data', (d) => { log += d.toString() })
  emulator.on('exit', (code) => { if (!shuttingDown) { console.error(`\n${c.red('✖')} The emulators exited (code ${code}).`); console.error(c.dim(log.split('\n').slice(-30).join('\n'))); shutdown(1) } })
  if (!(await waitFor(ports.firestore)) || !(await waitFor(ports.functions))) { console.log(c.red('failed')); console.error(c.dim(log.split('\n').slice(-30).join('\n'))); await shutdown(1); return }
  console.log(c.green('ready'))

  process.stdout.write(`  ${c.dim('2/3')} Bootstrapping a company and its first admin… `)
  const boot = spawn(process.execPath, [
    resolve(FRONTEND, 'functions/scripts/bootstrap-company.mjs'),
    '--project', PROJECT_ID, '--company-id', 'demo-builders', '--company-name', 'Demo Builders',
    '--admin-email', adminEmail, '--country', 'AU', '--currency', 'AUD', '--app-url', appBaseUrl,
  ], {
    cwd: resolve(FRONTEND, 'functions'),
    env: { ...process.env, FIRESTORE_EMULATOR_HOST: `${HOST}:${ports.firestore}`, FIREBASE_AUTH_EMULATOR_HOST: `${HOST}:${ports.auth}`, GOOGLE_APPLICATION_CREDENTIALS: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let bootOut = ''
  boot.stdout.on('data', (d) => { bootOut += d.toString() })
  boot.stderr.on('data', (d) => { bootOut += d.toString() })
  const bootCode = await new Promise((r) => boot.on('exit', r))
  if (bootCode !== 0) { console.log(c.red('failed')); console.error(bootOut); await shutdown(1); return }
  const link = bootOut.split('\n').find(l => l.startsWith(`${appBaseUrl}/accept-invite#`))
  console.log(c.green('done'))

  process.stdout.write(`  ${c.dim('3/3')} Starting Vite on ${HOST}:${vitePort}… `)
  const vite = spawnGroup(viteBin, ['--mode', 'emulator', '--port', String(vitePort), '--strictPort'], {
    env: {
      ...process.env,
      VITE_USE_FIREBASE_EMULATOR: 'true',
      VITE_USE_AUTH_EMULATOR: 'true',
      VITE_USE_FUNCTIONS_EMULATOR: 'true',
      VITE_FIRESTORE_EMULATOR_HOST: HOST,
      VITE_FIRESTORE_EMULATOR_PORT: String(ports.firestore),
      VITE_AUTH_EMULATOR_PORT: String(ports.auth),
      VITE_FUNCTIONS_EMULATOR_PORT: String(ports.functions),
      VITE_FIREBASE_PROJECT_ID: PROJECT_ID,
      VITE_FIREBASE_API_KEY: 'emulator',
      VITE_FIREBASE_APP_ID: '1:1:web:emulator',
      VITE_FIREBASE_AUTH_DOMAIN: `${PROJECT_ID}.firebaseapp.com`,
      VITE_FIREBASE_STORAGE_BUCKET: `${PROJECT_ID}.appspot.com`,
      VITE_FIREBASE_MESSAGING_SENDER_ID: '1',
      VITE_FIREBASE_APPCHECK_SITE_KEY: '',
    },
  })
  vite.stdout.on('data', () => {})
  vite.stderr.on('data', (d) => process.stderr.write(d))
  vite.on('exit', (code) => { if (!shuttingDown) { console.error(`\n${c.red('✖')} Vite exited (code ${code}).`); shutdown(1) } })
  if (!(await waitFor(vitePort))) { console.log(c.red('failed')); await shutdown(1); return }
  console.log(c.green('ready'))

  console.log(`\n  ${c.bold('Open the Company Admin acceptance link:')}`)
  console.log(`  ${c.cyan(link ?? '(link not found — see bootstrap output above)')}`)
  console.log(`\n  ${c.dim('Register as')} ${adminEmail} ${c.dim('(any 12+ character password), then Company Settings → Team.')}`)
  console.log(`  ${c.dim('Invitation emails land in Firestore at companies/demo-builders/devOutbox/{inviteId} (field "link").')}`)
  console.log(`  ${c.dim('App Check is skipped by the Functions emulator; production enforces it.')}`)
  console.log(`\n  ${c.dim('Ctrl+C stops everything.')}\n`)
}

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))
main().catch((e) => fail(e?.message ?? String(e)))
