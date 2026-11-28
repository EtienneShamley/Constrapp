import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { requireEmulators, PROJECT_ID } from './_harness.js'
import { emulatorEnvironmentProblems, CREDENTIAL_VARIABLES } from '../_emulatorGuard.js'

// ── The emulator run holds NO credential — proven from inside it (D3 #17) ────
//
// LOCAL NEGATIVE TESTS, run in the very process environment the Functions
// emulator and its runtime inherit (the launcher builds one environment for
// the CLI, and the CLI passes it on). They ask the same libraries the Admin
// SDK uses to FIND a credential, and require them to find nothing. No request
// leaves the machine: the metadata probe is switched off, and nothing here
// names or contacts a real project.

const requireFromFunctions = createRequire(new URL('../../functions/package.json', import.meta.url))

describe('credential isolation, from inside the emulator run', () => {
  it('the environment is the launcher’s: isolated home, demo project, loopback emulators, no credential variable', () => {
    requireEmulators()
    expect(emulatorEnvironmentProblems(process.env, 'functions')).toEqual([])
    expect(process.env.GCLOUD_PROJECT).toBe(PROJECT_ID)
    expect(PROJECT_ID.startsWith('demo-')).toBe(true)
    for (const name of CREDENTIAL_VARIABLES) expect(process.env[name] ?? '', name).toBe('')
    expect(process.env.HOME).toBe(process.env.CONSTRAP_EMULATOR_HOME)
  })

  it('there is no gcloud credential file and no Firebase CLI sign-in where this process would look for one', () => {
    const config = join(process.env.HOME, '.config')
    expect(existsSync(join(config, 'gcloud', 'application_default_credentials.json'))).toBe(false)
    const store = join(config, 'configstore', 'firebase-tools.json')
    if (existsSync(store)) {
      const content = requireFromFunctions('node:fs').readFileSync(store, 'utf8')
      const parsed = JSON.parse(content)
      expect(parsed.tokens).toBeUndefined()
      expect(parsed.user).toBeUndefined()
    }
  })

  it('google-auth-library — the library the Admin SDK and the Firebase CLI both use — finds NO Application Default Credentials', async () => {
    const { GoogleAuth } = requireFromFunctions('google-auth-library')
    const outcome = await new GoogleAuth().getApplicationDefault().then(() => 'FOUND', (e) => e)
    expect(outcome).not.toBe('FOUND')
    expect(String(outcome?.message ?? outcome)).toMatch(/Could not load the default credentials/i)
  })

  it('the Admin SDK’s own default credential cannot produce an access token', async () => {
    const { applicationDefault } = requireFromFunctions('firebase-admin/app')
    const outcome = await applicationDefault().getAccessToken().then(() => 'TOKEN', (e) => e)
    expect(outcome).not.toBe('TOKEN')
  })

  it('…and the Admin SDK still works against the emulators, which need no credential', async () => {
    const { admin } = await import('./_harness.js')
    const a = await admin()
    const ref = a.db.collection('isolationProbe').doc('one')
    await ref.set({ ok: true })
    expect((await ref.get()).data()).toEqual({ ok: true })
    await ref.delete()
  })
})
