import { describe, it, expect, afterAll } from 'vitest'
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import {
  emulatorEnvironmentProblems, assertEmulatorEnvironment, TEST_PROJECT_ID, PRODUCTION_PROJECT_IDS, CREDENTIAL_VARIABLES,
} from '../_emulatorGuard.js'
import {
  isolatedEmulatorEnv, isolationHomeProblems, prepareIsolation, credentialPathsIn, STRIPPED_VARIABLES,
  ISOLATION_MARKER, ISOLATION_HOME_VAR,
} from '../../scripts/emulatorIsolation.mjs'

// ── Emulator process isolation and the runtime gate (tracker D3 #17) ─────────
//
// The emulator CLI hands credentials to the Functions runtime when it can FIND
// them through its own environment: a credential variable, the gcloud file
// under $HOME/.config, or a Firebase CLI sign-in under $XDG_CONFIG_HOME. The
// launcher therefore starts the CLI in an environment where none of those
// exists, and the guard refuses a suite that was not started that way.
//
// Everything here is a LOCAL NEGATIVE TEST: fake credential files are planted
// in throwaway directories and the code is required to refuse. Nothing reads
// the operator's real configuration and nothing contacts a real project.

const read = (rel) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8')
const scratch = []
const tempDir = (prefix) => { const d = mkdtempSync(join(tmpdir(), prefix)); scratch.push(d); return d }
afterAll(() => { for (const d of scratch) rmSync(d, { recursive: true, force: true }) })

const REAL_HOME = '/Users/operator'           // a stand-in: nothing under it is ever read
const isolation = () => { const home = tempDir('constrap-isolation-'); mkdirSync(join(home, '.config'), { recursive: true }); return home }
const goodEnv = (home = isolation()) => ({
  ...isolatedEmulatorEnv({ PATH: '/usr/bin' }, { home, realHome: REAL_HOME }),
  FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080', FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099',
  FIREBASE_STORAGE_EMULATOR_HOST: '127.0.0.1:9199', GCLOUD_PROJECT: TEST_PROJECT_ID,
})
const problems = (env, suite = 'functions') => emulatorEnvironmentProblems(env, suite, { realHome: REAL_HOME })
const without = (env, key) => { const copy = { ...env }; delete copy[key]; return copy }

describe('the isolated emulator environment', () => {
  it('removes every credential and real-project variable, whatever its value', () => {
    const base = Object.fromEntries(STRIPPED_VARIABLES.map(n => [n, 'something-real']))
    const env = isolatedEmulatorEnv({ ...base, PATH: '/usr/bin', KEEP: 'yes' }, { home: '/tmp/iso', realHome: REAL_HOME })
    for (const name of STRIPPED_VARIABLES) expect(name in env, name).toBe(false)
    for (const name of CREDENTIAL_VARIABLES) expect(STRIPPED_VARIABLES, name).toContain(name)
    expect(env.KEEP).toBe('yes')
    expect(env.PATH).toBe('/usr/bin')
  })

  it('points HOME, XDG_CONFIG_HOME and CLOUDSDK_CONFIG into the isolation directory — the three places the CLI and the auth library look', () => {
    const env = isolatedEmulatorEnv({ HOME: REAL_HOME, XDG_CONFIG_HOME: `${REAL_HOME}/.config`, CLOUDSDK_CONFIG: `${REAL_HOME}/.config/gcloud` }, { home: '/tmp/iso', realHome: REAL_HOME })
    expect(env.HOME).toBe('/tmp/iso')
    expect(env.USERPROFILE).toBe('/tmp/iso')
    expect(env.XDG_CONFIG_HOME).toBe('/tmp/iso/.config')
    expect(env.CLOUDSDK_CONFIG).toBe('/tmp/iso/.config/gcloud')
    expect(env.METADATA_SERVER_DETECTION).toBe('none')
    expect(env[ISOLATION_MARKER]).toBe('1')
    expect(env[ISOLATION_HOME_VAR]).toBe('/tmp/iso')
    // The emulator BINARIES are still found: the download cache is not a credential.
    expect(env.FIREBASE_EMULATORS_PATH).toBe(`${REAL_HOME}/.cache/firebase/emulators`)
    expect(isolatedEmulatorEnv({ FIREBASE_EMULATORS_PATH: '/ci/cache' }, { home: '/tmp/iso', realHome: REAL_HOME }).FIREBASE_EMULATORS_PATH).toBe('/ci/cache')
  })

  it('does not change the caller’s environment', () => {
    const base = { HOME: REAL_HOME, GOOGLE_APPLICATION_CREDENTIALS: '/keys/x.json' }
    isolatedEmulatorEnv(base, { home: '/tmp/iso', realHome: REAL_HOME })
    expect(base).toEqual({ HOME: REAL_HOME, GOOGLE_APPLICATION_CREDENTIALS: '/keys/x.json' })
  })
})

describe('the isolation directory is checked before every run — a planted credential refuses the run', () => {
  it('a fresh directory is clean', () => {
    expect(isolationHomeProblems(isolation(), REAL_HOME)).toEqual([])
  })

  it('a gcloud Application Default Credentials file', () => {
    const home = isolation()
    mkdirSync(join(home, '.config', 'gcloud'), { recursive: true })
    writeFileSync(credentialPathsIn(home).gcloudAdc, '{"type":"authorized_user","refresh_token":"FAKE-FOR-TEST"}')
    expect(isolationHomeProblems(home, REAL_HOME).join(' ')).toMatch(/Application Default Credentials file exists/)
    expect(() => prepareIsolation({}, { home, realHome: REAL_HOME })).toThrow(/Refusing to start the emulators/)
  })

  it('a Firebase CLI sign-in (tokens, a user, or an additional account) — and an unreadable store', () => {
    for (const store of [{ tokens: { refresh_token: 'FAKE' } }, { user: { email: 'fake@example.test' } }, { additionalAccounts: [{ user: {} }] }]) {
      const home = isolation()
      mkdirSync(join(home, '.config', 'configstore'), { recursive: true })
      writeFileSync(credentialPathsIn(home).firebaseCliStore, JSON.stringify(store))
      expect(isolationHomeProblems(home, REAL_HOME).join(' '), JSON.stringify(Object.keys(store))).toMatch(/Firebase CLI sign-in exists/)
    }
    const broken = isolation()
    mkdirSync(join(broken, '.config', 'configstore'), { recursive: true })
    writeFileSync(credentialPathsIn(broken).firebaseCliStore, '{not json')
    expect(isolationHomeProblems(broken, REAL_HOME).join(' ')).toMatch(/unreadable/)
    // The store the CLI itself writes on first use (usage settings, no sign-in) is fine.
    const used = isolation()
    mkdirSync(join(used, '.config', 'configstore'), { recursive: true })
    writeFileSync(credentialPathsIn(used).firebaseCliStore, JSON.stringify({ motd: {}, usage: false, 'analytics-uuid': 'x' }))
    expect(isolationHomeProblems(used, REAL_HOME)).toEqual([])
  })

  it('the credential file the CLI writes for a signed-in account, and gcloud legacy credentials', () => {
    const home = isolation()
    mkdirSync(join(home, '.config', 'firebase'), { recursive: true })
    writeFileSync(join(home, '.config', 'firebase', 'fake_example_test_application_default_credentials.json'), '{}')
    expect(isolationHomeProblems(home, REAL_HOME).join(' ')).toMatch(/Firebase CLI credential file exists/)
    const legacy = isolation()
    mkdirSync(credentialPathsIn(legacy).gcloudLegacy, { recursive: true })
    expect(isolationHomeProblems(legacy, REAL_HOME).join(' ')).toMatch(/legacy credentials/)
  })

  it('the real home directory, a parent of it, or a directory inside the real configuration can never be the isolation directory', () => {
    expect(isolationHomeProblems(REAL_HOME, REAL_HOME).join(' ')).toMatch(/real home directory/)
    expect(isolationHomeProblems('/Users', REAL_HOME).join(' ')).toMatch(/real home directory/)
    expect(isolationHomeProblems(`${REAL_HOME}/.config/sub`, REAL_HOME).join(' ')).toMatch(/real configuration directory/)
    expect(isolationHomeProblems('', REAL_HOME)).toEqual(['no isolation directory'])
  })

  it('prepareIsolation creates the directory, returns the isolated environment, and writes nothing else', () => {
    const parent = tempDir('constrap-prepare-')
    const home = join(parent, 'home')
    const out = prepareIsolation({ PATH: '/usr/bin', FIREBASE_TOKEN: 'x' }, { home, realHome: REAL_HOME })
    expect(out.home).toBe(home)
    expect(out.env.HOME).toBe(home)
    expect('FIREBASE_TOKEN' in out.env).toBe(false)
    expect(readdirSync(home)).toEqual(['.config'])
    expect(readdirSync(join(home, '.config'))).toEqual([])
  })
})

describe('the suite guard fails closed', () => {
  it('accepts exactly the environment the launcher builds', () => {
    expect(problems(goodEnv(), 'functions')).toEqual([])
    expect(problems(goodEnv(), 'rules')).toEqual([])
    expect(problems({ ...goodEnv(), FIRESTORE_EMULATOR_HOST: 'localhost:8080' }, 'rules')).toEqual([])
  })

  it('a suite NOT started through the launcher is refused — no marker, the real HOME, or configuration outside the isolation directory', () => {
    const env = goodEnv()
    expect(problems(without(env, ISOLATION_MARKER)).join(' ')).toMatch(/isolating launcher/)
    expect(problems(without(env, ISOLATION_HOME_VAR)).join(' ')).toMatch(/is not set/)
    expect(problems({ ...env, HOME: REAL_HOME }).join(' ')).toMatch(/HOME is not the isolation directory/)
    expect(problems({ ...env, XDG_CONFIG_HOME: `${REAL_HOME}/.config` }).join(' ')).toMatch(/XDG_CONFIG_HOME/)
    expect(problems({ ...env, CLOUDSDK_CONFIG: `${REAL_HOME}/.config/gcloud` }).join(' ')).toMatch(/CLOUDSDK_CONFIG/)
    expect(problems(without(env, 'METADATA_SERVER_DETECTION')).join(' ')).toMatch(/METADATA_SERVER_DETECTION/)
    // A plain `firebase emulators:exec … vitest` environment: hosts and project set, nothing else.
    const bare = { FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080', FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099', GCLOUD_PROJECT: TEST_PROJECT_ID, HOME: REAL_HOME }
    expect(problems(bare).length).toBeGreaterThanOrEqual(2)
    expect(() => assertEmulatorEnvironment('functions', bare)).toThrow(/Refusing to run the functions suite/)
  })

  it('a credential that appears INSIDE the isolation directory refuses the suite', () => {
    const home = isolation()
    mkdirSync(join(home, '.config', 'gcloud'), { recursive: true })
    writeFileSync(credentialPathsIn(home).gcloudAdc, '{"type":"authorized_user"}')
    expect(problems(goodEnv(home)).join(' ')).toMatch(/Application Default Credentials file exists/)
  })

  it('any credential or token variable refuses the suite', () => {
    for (const name of CREDENTIAL_VARIABLES) {
      expect(problems({ ...goodEnv(), [name]: 'value' }).join(' '), name).toMatch(new RegExp(`${name} is set`))
    }
    expect(problems({ ...goodEnv(), GOOGLE_APPLICATION_CREDENTIALS: '' })).toEqual([])
  })

  it('a MISSING emulator host is a refusal, never a default; a host that is not loopback is refused', () => {
    const env = goodEnv()
    expect(problems(without(env, 'FIRESTORE_EMULATOR_HOST'))).toHaveLength(1)
    expect(problems(without(env, 'FIREBASE_AUTH_EMULATOR_HOST'), 'functions')).toHaveLength(1)
    expect(problems(without(env, 'FIREBASE_STORAGE_EMULATOR_HOST'), 'rules')).toHaveLength(1)
    for (const host of ['firestore.googleapis.com:443', '10.0.0.5:8080', '0.0.0.0:8080', 'emulator.internal:8080']) {
      expect(problems({ ...env, FIRESTORE_EMULATOR_HOST: host }).join(' ')).toMatch(/not a loopback address/)
    }
    expect(problems({ ...env, FIREBASE_STORAGE_EMULATOR_HOST: 'storage.googleapis.com:443' }, 'functions')).toHaveLength(1)
    expect(problems({ ...env, PUBSUB_EMULATOR_HOST: 'pubsub.googleapis.com:443' })).toHaveLength(1)
  })

  it('the project must be EXACTLY the demo project: production, any other id, another demo id and a missing id are refused', () => {
    expect(TEST_PROJECT_ID).toBe('demo-constrap-test')
    expect(TEST_PROJECT_ID.startsWith('demo-')).toBe(true)
    expect(PRODUCTION_PROJECT_IDS).toContain('constrapp-69b5d')
    const env = goodEnv()
    for (const id of PRODUCTION_PROJECT_IDS) {
      expect(problems({ ...env, GCLOUD_PROJECT: id }).join(' ')).toMatch(/PRODUCTION project/)
      expect(problems({ ...env, GOOGLE_CLOUD_PROJECT: id })).toHaveLength(1)
      expect(problems({ ...env, FIREBASE_CONFIG: JSON.stringify({ projectId: id }) }, 'rules')).toHaveLength(1)
    }
    for (const id of ['some-other-project', 'demo-something-else', 'constrapp-rules-test']) {
      expect(problems({ ...env, GCLOUD_PROJECT: id }), id).toHaveLength(1)
    }
    expect(problems(without(env, 'GCLOUD_PROJECT'))).toHaveLength(1)
    expect(problems({ ...env, GCLOUD_PROJECT: '' })).toHaveLength(1)
  })
})

describe('the isolation is wired into every emulator entry point', () => {
  it('both emulator test scripts go through the launcher, which fixes the project — it cannot be chosen on a command line', () => {
    const pkg = JSON.parse(read('package.json'))
    expect(pkg.scripts['test:rules']).toBe('node scripts/emulators-isolated.mjs firestore,storage "vitest run --config vitest.rules.config.js"')
    expect(pkg.scripts['test:functions']).toBe('node scripts/emulators-isolated.mjs auth,firestore,functions "vitest run --config vitest.functions.config.js"')
    const launcher = read('scripts/emulators-isolated.mjs')
    expect(launcher).toContain("['emulators:exec', '--only', only, '--project', TEST_PROJECT_ID, inner]")
    expect(launcher).toContain('env: isolation.env')
    expect(launcher).toContain('prepareIsolation()')
    expect(launcher).not.toMatch(/process\.env\.[A-Z_]*PROJECT/)
    for (const script of Object.values(pkg.scripts)) {
      for (const id of PRODUCTION_PROJECT_IDS) expect(script).not.toContain(id)
      expect(script).not.toContain('constrapp-rules-test')
    }
  })

  it('both suites run the guard as vitest globalSetup; the harness runs it again and never defaults the project', () => {
    expect(read('vitest.functions.config.js')).toContain("globalSetup: ['tests/_emulatorGuard.functions.js']")
    expect(read('vitest.rules.config.js')).toContain("globalSetup: ['tests/_emulatorGuard.rules.js']")
    expect(read('tests/_emulatorGuard.functions.js')).toContain("assertEmulatorEnvironment('functions')")
    expect(read('tests/_emulatorGuard.rules.js')).toContain("assertEmulatorEnvironment('rules')")
    const harness = read('tests/functions/_harness.js')
    expect(harness).toContain('export const PROJECT_ID = TEST_PROJECT_ID')
    expect(harness).not.toMatch(/GCLOUD_PROJECT\s*\?\?=/)
    expect(harness).toContain("assertEmulatorEnvironment('functions')")
    expect(harness).toContain('refusing to initialise the Admin SDK')
  })

  it('the full-emulator dev launcher starts the emulators and its bootstrap in the isolated environment, under the demo project', () => {
    const dev = read('scripts/team-dev.mjs')
    expect(dev).toContain("import { prepareIsolation, TEST_PROJECT_ID } from './emulatorIsolation.mjs'")
    expect(dev).toContain('const PROJECT_ID = TEST_PROJECT_ID')
    expect(dev).toContain("'--project', PROJECT_ID], { env: isolation.env })")
    expect(dev).toContain('env: { ...isolation.env, GCLOUD_PROJECT: PROJECT_ID,')
  })

  it('the Functions emulator has an env file for the demo project and none for the old test id; no backend source names a real project', () => {
    const files = readdirSync(fileURLToPath(new URL('../../functions/', import.meta.url)))
    expect(files).toContain(`.env.${TEST_PROJECT_ID}`)
    expect(files).not.toContain('.env.constrapp-rules-test')
    for (const id of PRODUCTION_PROJECT_IDS) {
      for (const rel of ['tests/functions/_harness.js', 'functions/src/index.js', 'functions/src/lib/firebaseAdmin.js', 'functions/src/lib/params.js', 'scripts/emulators-isolated.mjs']) {
        expect(read(rel), rel).not.toContain(id)
      }
    }
    // The Admin SDK is initialised with NO explicit credential and NO explicit
    // project: it can only take what the (isolated) environment gives it.
    const admin = read('functions/src/lib/firebaseAdmin.js')
    expect(admin).toContain('return getApps()[0] ?? initializeApp()')
    expect(admin).not.toMatch(/cert\(|credential:|projectId:|serviceAccount/)
  })
})

describe('the Node 22 runtime gate', () => {
  const SCRIPT = fileURLToPath(new URL('../../scripts/require-node-major.mjs', import.meta.url))
  const run = (arg) => spawnSync(process.execPath, [SCRIPT, ...(arg === undefined ? [] : [String(arg)])], { encoding: 'utf8' })
  const major = Number(process.versions.node.split('.')[0])

  it('passes only on the major version asked for, and changes nothing', () => {
    expect(run(major).status).toBe(0)
    expect(run(major).stdout).toContain(`Node ${process.versions.node}`)
    const other = run(major === 22 ? 24 : 22)
    expect(other.status).toBe(1)
    expect(other.stderr).toMatch(/must run under Node/)
    expect(run().status).toBe(2)
    expect(run('abc').status).toBe(2)
  })

  it('the acceptance scripts for the Functions runtime go through the gate; production pins nodejs22', () => {
    const pkg = JSON.parse(read('package.json'))
    expect(pkg.scripts['test:functions:node22']).toBe('node scripts/require-node-major.mjs 22 && npm run test:functions')
    expect(pkg.scripts['functions:test:node22']).toBe('node scripts/require-node-major.mjs 22 && npm --prefix functions test')
    expect(JSON.parse(read('firebase.json')).functions[0].runtime).toBe('nodejs22')
    expect(JSON.parse(read('functions/package.json')).engines.node).toBe('22')
    expect(pkg.scripts['test:unit']).toBe('vitest run --config vitest.config.js')
  })
})
