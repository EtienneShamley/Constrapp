// ── Emulator process isolation (tracker D3 #17; Phase 2 checkpoint 1) ────────
//
// WHY. `firebase emulators:exec|start` hands credentials to the Functions
// emulator's runtime in two ways (firebase-tools lib/emulator/env.js →
// getCredentialsEnvironment):
//   1. if google-auth-library finds Application Default Credentials — the
//      GOOGLE_APPLICATION_CREDENTIALS variable, or the gcloud file under
//      $HOME/.config/gcloud — the runtime inherits them through its
//      environment ("Application Default Credentials detected…");
//   2. otherwise, if the operator is signed in to the Firebase CLI (its store
//      is under $XDG_CONFIG_HOME or $HOME/.config/configstore), the CLI writes
//      that login's refresh token to a credential file and points
//      GOOGLE_APPLICATION_CREDENTIALS at it for the runtime.
// Both are found THROUGH THE ENVIRONMENT OF THE CLI PROCESS. Renaming the
// project does not change either.
//
// WHAT THIS DOES. It builds the environment the emulator CLI — and therefore
// every process it starts: the emulators, the Functions runtime, the test
// runner — is given, in which neither source exists:
//   · HOME, XDG_CONFIG_HOME and CLOUDSDK_CONFIG point into an ISOLATED, empty
//     directory, so there is no gcloud credential file and no CLI sign-in to
//     find. The operator's real files are not read, moved, changed or revoked;
//   · every variable that names a credential, a token or a real project is
//     removed;
//   · the metadata-server probe is switched off, so a credential lookup fails
//     at once instead of asking the network;
//   · the project is a `demo-` project, which the Firebase CLI itself treats as
//     local-only (it never contacts a real project for it);
//   · the emulator binaries are still found (FIREBASE_EMULATORS_PATH points at
//     the existing download cache — binaries only, no credentials).
// The isolated directory is checked before every run and the run is REFUSED if
// a credential has appeared in it.
//
// The same environment is used by `npm run test:rules`, `npm run
// test:functions` (scripts/emulators-isolated.mjs) and the full-emulator dev
// launcher (scripts/team-dev.mjs); tests/_emulatorGuard.js then refuses to
// start a suite that was not launched this way.

import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'

// The ONE emulator project. `demo-` projects are local-only by Firebase CLI
// design: emulated services use a demo configuration, and the CLI does not
// fetch anything about them from a real project.
export const TEST_PROJECT_ID = 'demo-constrap-test'

// Project ids that must never appear in an emulator run.
export const PRODUCTION_PROJECT_IDS = ['constrapp-69b5d']

export const ISOLATION_MARKER = 'CONSTRAP_EMULATOR_ISOLATED'
export const ISOLATION_HOME_VAR = 'CONSTRAP_EMULATOR_HOME'
// The operator's real home, as a PATH only — so a child process (whose HOME is
// the isolation directory) can still check it is not running inside it.
export const REAL_HOME_VAR = 'CONSTRAP_REAL_HOME'

// Removed from the emulator environment whatever their value.
export const STRIPPED_VARIABLES = [
  'GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_CLOUD_PROJECT', 'GCLOUD_PROJECT', 'GCP_PROJECT', 'GOOGLE_CLOUD_QUOTA_PROJECT',
  'FIREBASE_TOKEN', 'FIREBASE_CONFIG', 'FIREBASE_DEPLOY_AGENT', 'GOOGLE_OAUTH_ACCESS_TOKEN',
  'CLOUDSDK_AUTH_ACCESS_TOKEN', 'CLOUDSDK_CORE_PROJECT', 'CLOUDSDK_CORE_ACCOUNT', 'CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE',
  'GOOGLE_GHA_CREDS_PATH', 'GOOGLE_IMPERSONATE_SERVICE_ACCOUNT',
]

// A per-user directory outside the repository and outside the real home.
export const defaultIsolationHome = () => join(tmpdir(), 'constrap-emulator-home')

// Files that would be a credential if they existed inside the isolated home.
export function credentialPathsIn(home) {
  return {
    gcloudAdc: join(home, '.config', 'gcloud', 'application_default_credentials.json'),
    gcloudLegacy: join(home, '.config', 'gcloud', 'legacy_credentials'),
    firebaseCliStore: join(home, '.config', 'configstore', 'firebase-tools.json'),
    firebaseCliCredentialDir: join(home, '.config', 'firebase'),
  }
}

// The reasons `home` is NOT a clean isolation directory. Reads only inside
// `home` — never the operator's real configuration.
export function isolationHomeProblems(home, realHome = homedir()) {
  const problems = []
  if (typeof home !== 'string' || home.length === 0) return ['no isolation directory']
  const abs = resolve(home)
  const real = resolve(realHome)
  if (abs === real || real.startsWith(abs + sep)) problems.push('the isolation directory is, or contains, the real home directory')
  if (abs.startsWith(real + sep + '.config')) problems.push('the isolation directory is inside the real configuration directory')
  const paths = credentialPathsIn(abs)
  if (existsSync(paths.gcloudAdc)) problems.push('a gcloud Application Default Credentials file exists inside the isolation directory')
  if (existsSync(paths.gcloudLegacy)) problems.push('gcloud legacy credentials exist inside the isolation directory')
  if (existsSync(paths.firebaseCliCredentialDir) && readdirSync(paths.firebaseCliCredentialDir).some(f => f.endsWith('_application_default_credentials.json'))) {
    problems.push('a Firebase CLI credential file exists inside the isolation directory')
  }
  if (existsSync(paths.firebaseCliStore)) {
    let store = null
    try { store = JSON.parse(readFileSync(paths.firebaseCliStore, 'utf8')) } catch { problems.push('the Firebase CLI store inside the isolation directory is unreadable') }
    if (store && (store.tokens || store.user || (Array.isArray(store.additionalAccounts) && store.additionalAccounts.length > 0))) {
      problems.push('a Firebase CLI sign-in exists inside the isolation directory')
    }
  }
  return problems
}

// The environment for an emulator CLI process. Pure apart from reading
// `base`; creates nothing.
export function isolatedEmulatorEnv(base = process.env, { home = defaultIsolationHome(), realHome = homedir() } = {}) {
  const env = { ...base }
  for (const name of STRIPPED_VARIABLES) delete env[name]
  // The download cache of the emulator binaries stays where it is.
  env.FIREBASE_EMULATORS_PATH = base.FIREBASE_EMULATORS_PATH || join(realHome, '.cache', 'firebase', 'emulators')
  env.HOME = home
  env.USERPROFILE = home
  env.XDG_CONFIG_HOME = join(home, '.config')
  env.CLOUDSDK_CONFIG = join(home, '.config', 'gcloud')
  // google-auth-library / gcp-metadata: never probe the metadata server.
  env.METADATA_SERVER_DETECTION = 'none'
  env.NO_UPDATE_NOTIFIER = '1'
  env[ISOLATION_MARKER] = '1'
  env[ISOLATION_HOME_VAR] = home
  env[REAL_HOME_VAR] = base[REAL_HOME_VAR] || realHome
  return env
}

// Creates the isolation directory if needed and refuses an unclean one.
export function prepareIsolation(base = process.env, options = {}) {
  const home = options.home ?? defaultIsolationHome()
  mkdirSync(join(home, '.config'), { recursive: true })
  const problems = isolationHomeProblems(home, options.realHome)
  if (problems.length > 0) {
    throw new Error(`Refusing to start the emulators — the isolation directory ${home} is not clean:\n  - ${problems.join('\n  - ')}\nRemove that directory and try again. (It is a scratch directory; nothing of yours lives in it.)`)
  }
  return { home, env: isolatedEmulatorEnv(base, { ...options, home }) }
}
