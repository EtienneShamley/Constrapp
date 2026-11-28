#!/usr/bin/env node
// ── `firebase emulators:exec` in an isolated environment (tracker D3 #17) ────
//
//   node scripts/emulators-isolated.mjs <emulators> "<command>" [extra args…]
//
//   <emulators>   the --only list, e.g.  firestore,storage   or
//                 auth,firestore,functions
//   <command>     run by emulators:exec once the emulators answer; any extra
//                 arguments are appended to it (so a focused run can name
//                 test files:  npm run test:rules -- tests/rules/x.test.js)
//
// The project is ALWAYS the demo project (scripts/emulatorIsolation.mjs); it
// cannot be chosen on the command line. The CLI, the emulators, the Functions
// runtime and the command all run in the isolated environment built there: no
// credential file, no CLI sign-in, no credential variable, no metadata probe.

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { prepareIsolation, TEST_PROJECT_ID } from './emulatorIsolation.mjs'

const FRONTEND = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const [only, command, ...extra] = process.argv.slice(2)

if (!only || !command || !/^[a-z,]+$/.test(only)) {
  console.error('usage: node scripts/emulators-isolated.mjs <emulators> "<command>" [extra args…]')
  process.exit(2)
}

let isolation
try {
  isolation = prepareIsolation()
} catch (err) {
  console.error(err.message)
  process.exit(1)
}

const bin = resolve(FRONTEND, 'node_modules/.bin', process.platform === 'win32' ? 'firebase.cmd' : 'firebase')
if (!existsSync(bin)) {
  console.error('frontend/node_modules/.bin/firebase is missing — run `npm ci` in frontend/ first.')
  process.exit(1)
}

const quote = (arg) => (/^[A-Za-z0-9_./:=@-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`)
const inner = [command, ...extra.map(quote)].join(' ')

console.log(`[emulator isolation] project ${TEST_PROJECT_ID} · isolated home ${isolation.home} · emulators ${only}`)
const child = spawn(bin, ['emulators:exec', '--only', only, '--project', TEST_PROJECT_ID, inner], {
  cwd: FRONTEND, env: isolation.env, stdio: 'inherit',
})
child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 1)))
child.on('error', (err) => { console.error(err.message); process.exit(1) })
