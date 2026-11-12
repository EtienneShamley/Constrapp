import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTeamHandlers, HANDLER_NAMES } from '../src/team/handlers.js'
import { CODE, isTeamError } from '../src/lib/errors.js'

// Structural pins and the handler gates that need no Firestore at all.

const INDEX = readFileSync(fileURLToPath(new URL('../src/index.js', import.meta.url)), 'utf8')

const deps = (overrides = {}) => ({
  db: null, auth: null, email: null, now: () => new Date('2026-11-04T10:00:00Z'),
  config: () => ({ appBaseUrl: 'http://localhost', emailFrom: 'a@b', enabled: true, inviteTtlMs: 1000 }),
  log: { info() {}, warn() {}, error() {} }, ...overrides,
})

// ADR-74: each project resolves its OWN worker account from its own dotenv
// file — never another project's. A deploy reads only .env.<projectId>.
describe('worker service account per project', () => {
  const DIR = fileURLToPath(new URL('../', import.meta.url))
  const envFiles = readdirSync(DIR).filter(f => /^\.env\.[a-z0-9-]+$/.test(f) && f !== '.env.local')
  const valueOf = (file, key) => readFileSync(join(DIR, file), 'utf8').split('\n').find(l => l.startsWith(`${key}=`))?.slice(key.length + 1)

  it('every project env file names file-link-worker@ in THAT project, and the deploy-time regex accepts it', async () => {
    const { WORKER_SA_PATTERN } = await import('../src/lib/params.js')
    const re = new RegExp(WORKER_SA_PATTERN)
    expect(envFiles).toEqual(expect.arrayContaining(['.env.constrapp-69b5d', '.env.constrapp-rules-test']))
    for (const f of envFiles) {
      const project = f.slice('.env.'.length)
      const sa = valueOf(f, 'FILE_LINK_WORKER_SERVICE_ACCOUNT')
      expect(sa, f).toBe(`file-link-worker@${project}.iam.gserviceaccount.com`)
      expect(re.test(sa), f).toBe(true)
    }
  })

  it('the regex refuses the short form, another account name and a non-IAM domain', async () => {
    const re = new RegExp((await import('../src/lib/params.js')).WORKER_SA_PATTERN)
    for (const bad of ['file-link-worker@', 'file-link-worker', 'owner@constrapp-69b5d.iam.gserviceaccount.com',
      '123456789012-compute@developer.gserviceaccount.com', 'file-link-worker@constrapp-69b5d.iam.gserviceaccount.com.evil.example']) {
      expect(re.test(bad), bad).toBe(false)
    }
  })
})

describe('callable surface', () => {
  it('exactly eight handlers, each exported from index.js with onCall', () => {
    expect(HANDLER_NAMES).toEqual([
      'listTeam', 'createInvitation', 'resendInvitation', 'revokeInvitation',
      'previewInvitation', 'acceptInvitation', 'changeMemberRole', 'deactivateMember',
    ])
    const h = createTeamHandlers(deps())
    for (const n of HANDLER_NAMES) {
      expect(typeof h[n]).toBe('function')
      expect(INDEX).toContain(`export const ${n}`)
    }
    expect((INDEX.match(/wrap\('/g) || []).length).toBe(8)
  })

  it('every callable enforces App Check, one region, a secret binding and an instance cap', () => {
    expect(INDEX).toMatch(/enforceAppCheck:\s*true/)
    expect(INDEX).toMatch(/region:\s*REGION/)
    expect(INDEX).toMatch(/secrets:\s*\[EMAIL_API_KEY\]/)
    expect(INDEX).toMatch(/maxInstances:\s*\d+/)
    expect(INDEX).not.toMatch(/from\s*'express'|onRequest\(/)
  })

  it('ADR-74: exactly one scheduled worker beside the callables — one instance, one region, no secret, pausable', () => {
    expect((INDEX.match(/onSchedule\(/g) || []).length).toBe(1)
    expect(INDEX).toContain('export const processFileLinkRevocations = onSchedule(FILE_LINK_WORKER_OPTIONS')
    const opts = INDEX.slice(INDEX.indexOf('export const FILE_LINK_WORKER_OPTIONS'), INDEX.indexOf('export const processFileLinkRevocations'))
    expect(opts).toMatch(/schedule:\s*'every 1 minutes'/)
    expect(opts).toMatch(/region:\s*REGION/)
    expect(opts).toMatch(/maxInstances:\s*1,/)
    expect(opts).toMatch(/retryCount:\s*0/)
    expect(opts).not.toMatch(/secrets/)
    // A dedicated, PROJECT-RELATIVE runtime identity: the CLI expands `name@`
    // per project, so no project id (production or otherwise) is in source.
    expect(opts).toMatch(/serviceAccount:\s*FILE_LINK_WORKER_SERVICE_ACCOUNT,/)
    const PARAMS = readFileSync(fileURLToPath(new URL('../src/lib/params.js', import.meta.url)), 'utf8')
    expect(PARAMS).toContain("export const FILE_LINK_WORKER_SERVICE_ACCOUNT = defineString('FILE_LINK_WORKER_SERVICE_ACCOUNT'")
    expect(PARAMS).toMatch(/validationRegex: WORKER_SA_PATTERN/)
    const code = (PARAMS + INDEX).split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
    expect(code).not.toMatch(/constrapp-69b5d|constrap-dc46-validation|constrapp-rules-test|[0-9]{6,}-compute@/)
    // The callables keep the default runtime: only the worker has its own identity.
    expect(INDEX.slice(INDEX.indexOf('const CALL_OPTIONS'), INDEX.indexOf('let handlers'))).not.toMatch(/serviceAccount/)
    expect(INDEX).toMatch(/if \(!cfg\.enabled\) \{[^}]*return \}/)
    // Still no HTTP surface and no event triggers.
    expect(INDEX).not.toMatch(/onObjectFinalized|onDocument(Created|Written|Updated)|onRequest\(/)
  })

  it('the kill switch answers team-management-disabled before any data access', async () => {
    const h = createTeamHandlers(deps({ config: () => ({ enabled: false }) }))
    for (const n of HANDLER_NAMES) {
      try { await h[n]({ auth: { uid: 'u' }, data: {} }); throw new Error('no throw') }
      catch (e) { expect(isTeamError(e, CODE.DISABLED)).toBe(true) }
    }
  })

  it('an unauthenticated caller is refused by every authenticated callable before validation', async () => {
    const h = createTeamHandlers(deps())
    for (const n of HANDLER_NAMES.filter(x => x !== 'previewInvitation')) {
      try { await h[n]({ auth: null, data: { nonsense: true } }); throw new Error('no throw') }
      catch (e) { expect(isTeamError(e, CODE.UNAUTHENTICATED), n).toBe(true) }
    }
  })

  it('previewInvitation validates its credential shape before any lookup', async () => {
    const h = createTeamHandlers(deps())
    try { await h.previewInvitation({ auth: null, data: { companyId: 'c', inviteId: 'i', token: 'bad' } }); throw new Error('no throw') }
    catch (e) { expect(isTeamError(e, CODE.INVALID_ARGUMENT)).toBe(true) }
  })
})
