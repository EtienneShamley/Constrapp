#!/usr/bin/env node
// ── BOQ manual-acceptance launcher ───────────────────────────────────────────
//
//   npm run test:boq
//   TEST_USER_UID=<firebase-auth-uid> npm run test:boq
//
// One command that: starts the Firestore emulator, waits for it, seeds the two
// BOQ acceptance projects, then starts Vite with the emulator opt-in set FOR
// THAT CHILD PROCESS ONLY.
//
// Why this exists: the BOQ block in frontend/firestore.rules is deliberately
// NOT published yet, so manual testing against production Firestore fails with
// "Missing or insufficient permissions". This runs the app against a local
// emulator that loads those unpublished rules from disk.
//
// ⚠️ Firestore is emulated; AUTH IS NOT. Sign in with your real Constrapp
// account — the seed writes `users/{uid}` membership for real uids.
//
// It never writes `.env.local`, never publishes rules, and leaves
// `npm run dev` completely unchanged.

import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const HERE = dirname(fileURLToPath(import.meta.url))
const FRONTEND = resolve(HERE, '..')

const EMULATOR_HOST = '127.0.0.1'
const PREFERRED_VITE_PORT = 5174
const VITE_PORT_FALLBACKS = [5175, 5176, 5177, 5180]

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
}

const children = []
let shuttingDown = false

// ── Helpers ──────────────────────────────────────────────────────────────────

function fail(message) {
  console.error(`\n${c.red('✖')} ${message}\n`)
  process.exit(1)
}

function parseEnvFile(path) {
  const out = {}
  if (!existsSync(path)) return out
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq === -1) continue
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim()
  }
  return out
}

function portFree(port) {
  return new Promise((res) => {
    const server = createServer()
    server.once('error', () => res(false))
    server.once('listening', () => server.close(() => res(true)))
    server.listen(port, EMULATOR_HOST)
  })
}

async function firstFreePort(preferred, fallbacks) {
  if (await portFree(preferred)) return preferred
  for (const p of fallbacks) if (await portFree(p)) return p
  return null
}

async function waitForEmulator(port, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (shuttingDown) return false
    try {
      const res = await fetch(`http://${EMULATOR_HOST}:${port}/`)
      // The Firestore emulator answers "Ok" on /; any HTTP answer means listening.
      if (res.status > 0) return true
    } catch {
      // not up yet
    }
    await sleep(300)
  }
  return false
}

// Spawns in its OWN PROCESS GROUP (detached) so shutdown can signal the whole
// tree — the emulator forks a Java child that a bare child.kill() would orphan.
function spawnGroup(command, args, opts = {}) {
  const child = spawn(command, args, {
    cwd: FRONTEND,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...opts,
  })
  children.push(child)
  return child
}

function killGroup(child, signal) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  try {
    process.kill(-child.pid, signal)
  } catch {
    try { child.kill(signal) } catch { /* already gone */ }
  }
}

async function shutdown(code = 0) {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`\n${c.dim('Shutting down Vite and the Firestore emulator…')}`)

  for (const child of children) killGroup(child, 'SIGTERM')
  // Give the emulator a moment to release its ports, then be certain.
  await sleep(2500)
  for (const child of children) killGroup(child, 'SIGKILL')
  await sleep(300)

  console.log(c.dim('Stopped. Emulator data was in-memory and is now discarded.'))
  process.exit(code)
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  // Barrier 1: service-account credentials must not be in scope at all.
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    fail('GOOGLE_APPLICATION_CREDENTIALS is set. Unset it before running local emulator testing.')
  }

  const firebaseBin = resolve(FRONTEND, 'node_modules/.bin/firebase')
  const viteBin = resolve(FRONTEND, 'node_modules/.bin/vite')
  if (!existsSync(firebaseBin)) fail('firebase-tools not found in node_modules. Run `npm install` in frontend/.')
  if (!existsSync(viteBin)) fail('vite not found in node_modules. Run `npm install` in frontend/.')

  // The emulator must run under the SAME project id the browser app uses, or
  // the app would connect to a different (empty) emulator namespace.
  const env = parseEnvFile(resolve(FRONTEND, '.env.local'))
  const projectId = env.VITE_FIREBASE_PROJECT_ID
  if (!projectId) fail('VITE_FIREBASE_PROJECT_ID not found in frontend/.env.local — cannot align the emulator with the app.')

  const firestorePort = Number(
    JSON.parse(readFileSync(resolve(FRONTEND, 'firebase.json'), 'utf8'))?.emulators?.firestore?.port ?? 8080,
  )

  if (!(await portFree(firestorePort))) {
    fail(`Port ${firestorePort} is already in use — another emulator is probably running.\n  Stop it, or run: lsof -ti tcp:${firestorePort} | xargs kill`)
  }

  const vitePort = await firstFreePort(PREFERRED_VITE_PORT, VITE_PORT_FALLBACKS)
  if (!vitePort) fail(`No free port among ${[PREFERRED_VITE_PORT, ...VITE_PORT_FALLBACKS].join(', ')}.`)

  const testUserUid = (process.env.TEST_USER_UID || '').trim()

  console.log(`\n${c.bold('BOQ manual acceptance')} ${c.dim(`· project ${projectId}`)}`)
  console.log(c.dim('─'.repeat(64)))

  // ── 1. Emulator ────────────────────────────────────────────────────────────
  process.stdout.write(`  ${c.dim('1/3')} Starting Firestore emulator on ${EMULATOR_HOST}:${firestorePort}… `)
  const emulator = spawnGroup(firebaseBin, [
    'emulators:start',
    '--only', 'firestore',
    '--project', projectId,
  ])

  let emulatorLog = ''
  emulator.stdout.on('data', (d) => { emulatorLog += d.toString() })
  emulator.stderr.on('data', (d) => { emulatorLog += d.toString() })
  emulator.on('exit', (code) => {
    if (!shuttingDown) {
      console.error(`\n${c.red('✖')} The Firestore emulator exited unexpectedly (code ${code}).`)
      console.error(c.dim(emulatorLog.split('\n').slice(-25).join('\n')))
      shutdown(1)
    }
  })

  if (!(await waitForEmulator(firestorePort))) {
    console.log(c.red('failed'))
    console.error(c.dim(emulatorLog.split('\n').slice(-25).join('\n')))
    await shutdown(1)
    return
  }
  console.log(c.green('ready'))

  // ── 2. Seed ────────────────────────────────────────────────────────────────
  process.stdout.write(`  ${c.dim('2/3')} Seeding BOQ acceptance data… `)
  const seedEnv = {
    ...process.env,
    FIRESTORE_EMULATOR_HOST: `${EMULATOR_HOST}:${firestorePort}`,
    SEED_PROJECT_ID: projectId,
    ...(testUserUid ? { TEST_USER_UID: testUserUid } : {}),
  }
  delete seedEnv.GOOGLE_APPLICATION_CREDENTIALS

  const seedOk = await new Promise((res) => {
    const seed = spawn(process.execPath, [resolve(HERE, 'seed-boq-emulator.mjs')], {
      cwd: FRONTEND,
      env: seedEnv,
      stdio: ['ignore', 'pipe', 'inherit'],
    })
    let out = ''
    seed.stdout.on('data', (d) => { out += d.toString() })
    seed.on('exit', (code) => res(code === 0 ? out : null))
  })

  if (seedOk === null) {
    console.log(c.red('failed'))
    await shutdown(1)
    return
  }
  console.log(c.green('done'))

  // ── 3. Vite ────────────────────────────────────────────────────────────────
  process.stdout.write(`  ${c.dim('3/3')} Starting Vite on port ${vitePort}… `)
  // `--mode emulator` is the tamper-proof half of the gate in src/lib/firebase.js:
  // a `.env` file can set VITE_USE_FIREBASE_EMULATOR but can never set MODE, so
  // only this launcher can satisfy both. The opt-in flag is passed through the
  // child's process environment (which takes precedence over `.env.local` —
  // verified) and is never written to any file.
  const vite = spawnGroup(viteBin, [
    '--mode', 'emulator',
    '--port', String(vitePort),
    '--strictPort',
  ], {
    env: {
      ...process.env,
      VITE_USE_FIREBASE_EMULATOR: 'true',
    },
  })

  let viteReady = false
  const onViteOut = (d) => {
    const text = d.toString()
    if (!viteReady && /ready in|Local:/i.test(text)) {
      viteReady = true
      console.log(c.green('ready'))
      printBanner()
    }
    if (viteReady) process.stdout.write(c.dim(text))
  }
  vite.stdout.on('data', onViteOut)
  vite.stderr.on('data', (d) => process.stderr.write(c.dim(d.toString())))
  vite.on('exit', (code) => {
    if (!shuttingDown) {
      console.error(`\n${c.red('✖')} Vite exited unexpectedly (code ${code}).`)
      shutdown(1)
    }
  })

  function printBanner() {
    const url = `http://localhost:${vitePort}/`
    console.log(`\n${c.bold(c.green('  ▸ Open ' + url))}\n`)
    console.log(`  ${c.bold('Firestore')}   ${c.yellow('LOCAL EMULATOR')} ${EMULATOR_HOST}:${firestorePort} ${c.dim('(disposable, in-memory)')}`)
    console.log(`  ${c.bold('Rules')}       ${c.dim('frontend/firestore.rules — loaded from disk, UNPUBLISHED')}`)
    console.log(`  ${c.bold('Auth')}        ${c.cyan('REAL Firebase Auth')} ${c.dim('— sign in with your normal Constrapp account')}`)
    console.log(`  ${c.bold('Company')}     Apex Builders ${c.dim('(2Vf3CVuYE8wWzg8hLjR5)')}`)
    console.log(`\n  ${c.bold('Seeded membership (company_admin):')}`)
    console.log(`    · ${'igCEJR3XzdTd5JEIJSC5QyP5eBB3'} ${c.dim('(Etienne — default)')}`)
    if (testUserUid && testUserUid !== 'igCEJR3XzdTd5JEIJSC5QyP5eBB3') {
      console.log(`    · ${testUserUid} ${c.dim('(TEST_USER_UID)')}`)
    } else {
      console.log(c.dim('    (set TEST_USER_UID=<uid> to seed another tester)'))
    }
    console.log(`\n  ${c.bold('Seeded projects:')}`)
    console.log(`    1. ${c.bold('BOQ Currency Test Project')}`)
    console.log(c.dim('       No monetary records at all · currencyLocked: false'))
    console.log(c.dim('       → §15s-v: an UNPRICED item must NOT lock the currency; pricing it MUST.'))
    console.log(`    2. ${c.bold('BOQ Comparison Test Project')}`)
    console.log(c.dim('       Approved Budget $20,000 — 0300 Concrete $12,000 · 0400 Formwork $8,000'))
    console.log(c.dim('       → §15s-ii/iii/iv: enter the three BOQ items; expect BOQ $15,000, Variance +$5,000.'))
    console.log(`\n  ${c.dim('Ctrl+C stops Vite and the emulator and discards all emulator data.')}\n`)
  }

  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => { shutdown(0) })
  }
}

main().catch(async (err) => {
  console.error(`\n${c.red('✖')} ${err?.message ?? err}`)
  await shutdown(1)
})
