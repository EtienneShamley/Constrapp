// ── Emulator isolation guard (tracker D3 #17) ────────────────────────────────
//
// The Rules and Functions suites must only ever run against LOCAL emulators,
// under the DEMO project, in a process environment that holds NO credential.
// The launcher (scripts/emulators-isolated.mjs → scripts/emulatorIsolation.mjs)
// builds that environment; this guard runs once before either suite (vitest
// `globalSetup`) and again before the Admin SDK is initialised, and REFUSES TO
// START when any part of it is missing or points somewhere else. It fails
// closed: a missing variable is a refusal, never a default.
//
// What it requires:
//   · the launcher's marker, and HOME equal to the isolation directory it made;
//   · that directory holding no gcloud credential file, no Firebase CLI
//     sign-in and no CLI credential file (checked inside that directory only —
//     the operator's real configuration is never read);
//   · no credential or token variable in the environment;
//   · every emulator host present and on a loopback address;
//   · the project id exactly the demo project — never a real one.
//
// Running a suite directly (`firebase emulators:exec … vitest`, or `vitest`
// alone) is therefore refused: use `npm run test:rules` / `npm run
// test:functions`, optionally followed by `-- <test file>`.

import { resolve } from 'node:path'
import {
  TEST_PROJECT_ID, PRODUCTION_PROJECT_IDS, ISOLATION_MARKER, ISOLATION_HOME_VAR, REAL_HOME_VAR, isolationHomeProblems,
} from '../scripts/emulatorIsolation.mjs'

export { TEST_PROJECT_ID, PRODUCTION_PROJECT_IDS }

const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '[::1]', '::1']

// Variables that would hand the process a credential. (GCLOUD_PROJECT is set
// by `emulators:exec` itself and is checked separately, below.)
export const CREDENTIAL_VARIABLES = [
  'GOOGLE_APPLICATION_CREDENTIALS', 'FIREBASE_TOKEN', 'GOOGLE_OAUTH_ACCESS_TOKEN', 'CLOUDSDK_AUTH_ACCESS_TOKEN',
  'CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE', 'GOOGLE_IMPERSONATE_SERVICE_ACCOUNT', 'GOOGLE_GHA_CREDS_PATH',
]

function hostOf(value) {
  if (typeof value !== 'string' || value.length === 0) return null
  const at = value.lastIndexOf(':')
  return at === -1 ? value : value.slice(0, at)
}

// The reasons `env` is NOT a safe emulator environment for `suite`
// ('rules' or 'functions'). An empty list means the suite may run.
// `realHome` is injectable for the unit tests.
export function emulatorEnvironmentProblems(env, suite, { realHome } = {}) {
  const problems = []

  // 1. Launched through the isolating launcher, into its directory.
  if (env[ISOLATION_MARKER] !== '1') {
    problems.push('the suite was not started through the isolating launcher — use `npm run test:rules` / `npm run test:functions`')
  }
  const isolationHome = env[ISOLATION_HOME_VAR]
  if (typeof isolationHome !== 'string' || isolationHome.length === 0) {
    problems.push(`${ISOLATION_HOME_VAR} is not set`)
  } else {
    if (typeof env.HOME !== 'string' || resolve(env.HOME) !== resolve(isolationHome)) problems.push('HOME is not the isolation directory — the process could find the operator\'s credentials')
    if (typeof env.XDG_CONFIG_HOME !== 'string' || !resolve(env.XDG_CONFIG_HOME).startsWith(resolve(isolationHome))) problems.push('XDG_CONFIG_HOME is not inside the isolation directory')
    if (typeof env.CLOUDSDK_CONFIG !== 'string' || !resolve(env.CLOUDSDK_CONFIG).startsWith(resolve(isolationHome))) problems.push('CLOUDSDK_CONFIG is not inside the isolation directory')
    // Inside the run HOME *is* the isolation directory, so the operator's real
    // home is taken from the launcher's record of it (a path, nothing more).
    const real = realHome ?? env[REAL_HOME_VAR]
    if (typeof real !== 'string' || real.length === 0) problems.push(`${REAL_HOME_VAR} is not set — cannot confirm the run is outside the real home directory`)
    else for (const p of isolationHomeProblems(isolationHome, real)) problems.push(p)
  }
  if (env.METADATA_SERVER_DETECTION !== 'none') problems.push('METADATA_SERVER_DETECTION is not "none" — a credential lookup could probe the network')

  // 2. No credential in the environment.
  for (const name of CREDENTIAL_VARIABLES) {
    if (typeof env[name] === 'string' && env[name].length > 0) problems.push(`${name} is set — no credential may be configured for an emulator run`)
  }

  // 3. Emulator hosts: present and loopback.
  const required = suite === 'functions'
    ? ['FIRESTORE_EMULATOR_HOST', 'FIREBASE_AUTH_EMULATOR_HOST']
    : ['FIRESTORE_EMULATOR_HOST', 'FIREBASE_STORAGE_EMULATOR_HOST']
  for (const name of required) {
    const host = hostOf(env[name])
    if (host === null) problems.push(`${name} is not set — the suite would not be talking to an emulator`)
    else if (!LOOPBACK_HOSTS.includes(host)) problems.push(`${name} is "${env[name]}" — not a loopback address`)
  }
  for (const name of ['FIREBASE_AUTH_EMULATOR_HOST', 'FIREBASE_STORAGE_EMULATOR_HOST', 'FIREBASE_DATABASE_EMULATOR_HOST', 'PUBSUB_EMULATOR_HOST']) {
    if (required.includes(name) || env[name] === undefined) continue
    if (!LOOPBACK_HOSTS.includes(hostOf(env[name]))) problems.push(`${name} is "${env[name]}" — not a loopback address`)
  }

  // 4. The project: exactly the demo project.
  const project = env.GCLOUD_PROJECT
  if (typeof project !== 'string' || project.length === 0) {
    problems.push('GCLOUD_PROJECT is not set — run the suite through the isolating launcher')
  } else if (PRODUCTION_PROJECT_IDS.includes(project)) {
    problems.push(`GCLOUD_PROJECT is the PRODUCTION project "${project}"`)
  } else if (project !== TEST_PROJECT_ID) {
    problems.push(`GCLOUD_PROJECT is "${project}" — the only emulator project is "${TEST_PROJECT_ID}"`)
  }
  for (const name of ['GOOGLE_CLOUD_PROJECT', 'GCP_PROJECT', 'FIREBASE_CONFIG', 'CLOUDSDK_CORE_PROJECT']) {
    const value = env[name]
    if (typeof value !== 'string' || value.length === 0) continue
    if (PRODUCTION_PROJECT_IDS.some(id => value.includes(id))) problems.push(`${name} names a production project`)
  }
  return problems
}

export function assertEmulatorEnvironment(suite, env = process.env) {
  const problems = emulatorEnvironmentProblems(env, suite)
  if (problems.length > 0) {
    throw new Error(`Refusing to run the ${suite} suite outside an isolated emulator environment:\n  - ${problems.join('\n  - ')}`)
  }
}

// What actually ran — recorded in the test output so an acceptance run can be
// read back (the production Functions runtime is Node 22; firebase.json).
export function runtimeSummary(env = process.env) {
  return `node ${process.version} · project ${env.GCLOUD_PROJECT} · isolated home · firestore ${env.FIRESTORE_EMULATOR_HOST}`
    + (env.FIREBASE_AUTH_EMULATOR_HOST ? ` · auth ${env.FIREBASE_AUTH_EMULATOR_HOST}` : '')
    + (env.FIREBASE_STORAGE_EMULATOR_HOST ? ` · storage ${env.FIREBASE_STORAGE_EMULATOR_HOST}` : '')
}
