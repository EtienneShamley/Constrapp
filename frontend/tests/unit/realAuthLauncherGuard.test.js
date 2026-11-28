import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { realAuthLauncherRefusal, CONFIRM_VARIABLE } from '../../scripts/realAuthLauncherGuard.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const base = { projectId: 'some-real-project', launcher: 'test:boq' }

describe('D3 #40 — the three real-Auth launchers never start by accident', () => {
  it('refuses by default, naming the project and the safe alternative', () => {
    const reason = realAuthLauncherRefusal({ ...base, env: {} })
    expect(reason).toMatch(/REAL project "some-real-project"/)
    expect(reason).toMatch(/test:team/)
  })

  it('refuses a confirmation that names a different project, or is empty', () => {
    for (const value of ['', 'other-project', 'some-real-project ', 'SOME-REAL-PROJECT', 'true', '1']) {
      expect(realAuthLauncherRefusal({ ...base, env: { [CONFIRM_VARIABLE]: value } }), JSON.stringify(value)).not.toBeNull()
    }
  })

  it('allows a separately authorised session that names the exact project', () => {
    expect(realAuthLauncherRefusal({ ...base, env: { [CONFIRM_VARIABLE]: 'some-real-project' } })).toBeNull()
  })

  it('refuses under every CI marker even when confirmed', () => {
    for (const ci of ['CI', 'TF_BUILD', 'GITHUB_ACTIONS']) {
      for (const value of ['true', '1', 'True']) {
        const env = { [ci]: value, [CONFIRM_VARIABLE]: 'some-real-project' }
        expect(realAuthLauncherRefusal({ ...base, env }), `${ci}=${value}`).toMatch(/never run in automated environments/)
      }
    }
    expect(realAuthLauncherRefusal({ ...base, env: { CI: 'false', [CONFIRM_VARIABLE]: 'some-real-project' } })).toBeNull()
  })

  it('refuses when no project id was found', () => {
    expect(realAuthLauncherRefusal({ launcher: 'test:quant', projectId: '', env: { [CONFIRM_VARIABLE]: '' } })).toMatch(/no Firebase project id/)
  })

  it('each of the three launchers calls the guard after reading the project id and before starting anything', () => {
    for (const [file, launcher] of [['boq-dev.mjs', 'test:boq'], ['quant-dev.mjs', 'test:quant'], ['credit-notes-dev.mjs', 'test:credit-notes']]) {
      const src = readFileSync(resolve(HERE, '../../scripts', file), 'utf8')
      const guard = src.indexOf(`assertRealAuthLauncherAllowed({`)
      expect(guard, file).toBeGreaterThan(0)
      expect(src.slice(guard, guard + 120), file).toContain(`'${launcher}'`)
      // The guard precedes the point where the emulators are started.
      const start = Math.max(src.indexOf("'emulators:start'"), src.indexOf("'emulators:exec'"))
      expect(start, file).toBeGreaterThan(guard)
    }
  })
})
