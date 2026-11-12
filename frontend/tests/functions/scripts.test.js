import { beforeAll, beforeEach, describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { admin, resetEmulators, makeHandlers, seedCompany, seedUser, req, parseLink, COMPANY_A, PROJECT_ID } from './_harness.js'

// ── Operator scripts against the emulators ──────────────────────────────────

const HERE = dirname(fileURLToPath(import.meta.url))
const FUNCTIONS = resolve(HERE, '../../functions')

function run(script, args, extraEnv = {}) {
  const r = spawnSync(process.execPath, [resolve(FUNCTIONS, 'scripts', script), ...args], {
    cwd: FUNCTIONS,
    env: { ...process.env, APP_BASE_URL: 'http://localhost:5173', GOOGLE_APPLICATION_CREDENTIALS: '', ...extraEnv },
    encoding: 'utf8',
  })
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, out: `${r.stdout}\n${r.stderr}` }
}

// RECONCILE_JSON=1 contract: stdout is EXACTLY one line of JSON; everything
// else (the human report, Node/SDK warnings) is on stderr. Parsed from stdout
// alone — never from the combined stream, whose last line is stderr's whenever
// the runtime prints a warning (Azure builds #136/#137: a MetadataLookupWarning
// on an agent with no ADC made the "last line" Node's `(Use \`node --trace-…`).
function findingsOf(r) {
  const lines = r.stdout.split('\n').filter(l => l.length > 0)
  expect(lines, `stdout must be one JSON line; stderr was:\n${r.stderr}`).toHaveLength(1)
  return JSON.parse(lines[0])
}

const WARNING_PRELOAD = resolve(HERE, 'fixtures/emit-warning.mjs')

let A
beforeAll(async () => { A = await admin() })
beforeEach(async () => { await resetEmulators() })

describe('bootstrap-company.mjs', () => {
  const base = ['--project', PROJECT_ID, '--company-id', 'acme', '--company-name', 'Acme Builders', '--admin-email', 'Ada@Acme.test', '--country', 'AU', '--currency', 'AUD']

  it('validates its arguments and refuses to run without an explicit project', () => {
    expect(run('bootstrap-company.mjs', []).code).toBe(2)
    expect(run('bootstrap-company.mjs', ['--project', PROJECT_ID, '--company-id', 'Bad Id', '--company-name', 'x', '--admin-email', 'a@b.co']).code).toBe(2)
    expect(run('bootstrap-company.mjs', [...base, '--bogus']).code).toBe(2)
  })

  it('dry-run writes nothing; the real run creates the company, an operator invitation and prints the link once', async () => {
    const dry = run('bootstrap-company.mjs', [...base, '--dry-run'])
    expect(dry.code).toBe(0)
    expect(dry.out).toContain('DRY RUN')
    expect((await A.db.collection('companies').doc('acme').get()).exists).toBe(false)

    const real = run('bootstrap-company.mjs', base)
    expect(real.code).toBe(0)
    const link = real.out.split('\n').find(l => l.startsWith('http://localhost:5173/accept-invite#'))
    expect(link).toBeTruthy()
    const company = await A.db.collection('companies').doc('acme').get()
    expect(company.data()).toMatchObject({ name: 'Acme Builders', countryCode: 'AU', baseCurrency: 'AUD' })
    const cred = parseLink(link)
    const inv = await A.db.collection('companies').doc('acme').collection('invitations').doc(cred.inviteId).get()
    expect(inv.data()).toMatchObject({ email: 'ada@acme.test', role: 'company_admin', status: 'pending', deliveredVia: 'operator' })
    expect(real.out).not.toContain(inv.data().tokenHash)
    const audits = (await A.db.collection('companies').doc('acme').collection('auditEvents').get()).docs.map(d => d.data().type)
    expect(audits).toEqual(expect.arrayContaining(['company.bootstrapped', 'invite.created']))

    // The printed link is a working invitation; acceptance makes the first admin.
    const { handlers: H } = await makeHandlers()
    expect((await H.previewInvitation(req(null, cred))).accountState).toBe('new')
    await A.auth.createUser({ uid: 'u_ada', email: 'ada@acme.test', password: 'correct-horse-battery' })
    await H.acceptInvitation(req('u_ada', cred))
    expect((await A.db.collection('users').doc('u_ada').get()).data()).toMatchObject({ companyId: 'acme', role: 'company_admin' })
    expect((await A.auth.getUser('u_ada')).emailVerified).toBe(false)   // operator link proves no mailbox

    // Idempotent: re-running reports nothing to do; a different name is refused.
    const again = run('bootstrap-company.mjs', base)
    expect(again.code).toBe(0)
    expect(again.out).toContain('already an active Company Admin')
    const renamed = run('bootstrap-company.mjs', [...base.slice(0, 5), 'Other Name', ...base.slice(6)])
    expect(renamed.code).toBe(1)
    expect(renamed.out).toContain('Refusing')
  })

  it('re-running before acceptance rotates the pending invitation instead of creating a second one', async () => {
    const first = run('bootstrap-company.mjs', base)
    const link1 = first.out.split('\n').find(l => l.startsWith('http://localhost:5173/accept-invite#'))
    const second = run('bootstrap-company.mjs', base)
    const link2 = second.out.split('\n').find(l => l.startsWith('http://localhost:5173/accept-invite#'))
    expect(parseLink(link1).inviteId).toBe(parseLink(link2).inviteId)
    expect(parseLink(link1).token).not.toBe(parseLink(link2).token)
    expect((await A.db.collection('companies').doc('acme').collection('invitations').get()).size).toBe(1)
    const { handlers: H, CODE } = { ...(await makeHandlers()), CODE: A.CODE }
    await expect(H.previewInvitation(req(null, parseLink(link1)))).rejects.toMatchObject({ details: { code: CODE.INVALID_INVITATION } })
    expect((await H.previewInvitation(req(null, parseLink(link2)))).accountState).toBe('new')
  })
})

describe('reconcile-membership.mjs', () => {
  it('reports pending Auth sync, a missing admin and disabled active accounts; --fix completes only the Auth sync', async () => {
    await seedCompany(COMPANY_A)
    await seedUser({ uid: 'u_admin', email: 'admin@acme.test', role: 'company_admin', companyId: COMPANY_A })
    await seedUser({ uid: 'u_pm', email: 'pm@acme.test', role: 'project_manager', companyId: COMPANY_A })
    await seedUser({ uid: 'u_qs', email: 'qs@acme.test', role: 'qs', companyId: COMPANY_A })
    await seedCompany('emptyco')

    // A deactivation whose Auth step failed.
    let fail = true
    const flakyAuth = new Proxy(A.auth, { get(t, p) { if (p === 'updateUser' && fail) return async () => { fail = false; throw new Error('outage') }; const v = t[p]; return typeof v === 'function' ? v.bind(t) : v } })
    const { handlers: H } = await makeHandlers({ auth: flakyAuth })
    expect((await H.deactivateMember(req('u_admin', { uid: 'u_pm' }))).authSynced).toBe(false)
    // An active member whose Auth got disabled out of band.
    await A.auth.updateUser('u_qs', { disabled: true })

    const report = run('reconcile-membership.mjs', ['--project', PROJECT_ID], { RECONCILE_JSON: '1' })
    expect(report.code).toBe(0)
    const findings = findingsOf(report)
    expect(findings.map(f => f.code).sort()).toEqual(['F1', 'R1', 'R2'])
    expect((await A.auth.getUser('u_pm')).disabled).toBe(false)   // report only

    const fixed = run('reconcile-membership.mjs', ['--project', PROJECT_ID, '--fix'], { RECONCILE_JSON: '1' })
    expect(fixed.code).toBe(0)
    expect((await A.auth.getUser('u_pm')).disabled).toBe(true)
    expect((await A.db.collection('users').doc('u_pm').get()).data().authSyncPending).toBe(false)
    expect((await A.auth.getUser('u_qs')).disabled).toBe(true)   // R2 untouched — needs a human
    const audits = (await A.db.collection('companies').doc(COMPANY_A).collection('auditEvents').get()).docs.map(d => d.data().type)
    expect(audits).toContain('reconcile.fix')

    const clean = run('reconcile-membership.mjs', ['--project', PROJECT_ID, '--company-id', COMPANY_A], { RECONCILE_JSON: '1' })
    expect(findingsOf(clean).map(f => f.code)).toEqual(['R2'])
  })

  // Regression (Azure #136/#137): a runtime warning on stderr must not corrupt
  // the machine-readable report, and the human report must keep its stream.
  it('keeps the JSON report on stdout when the runtime prints warnings, and the human report off it', async () => {
    await seedCompany('emptyco')   // no admin → exactly one R1

    const noisy = run('reconcile-membership.mjs', ['--project', PROJECT_ID], {
      RECONCILE_JSON: '1',
      NODE_OPTIONS: `--import=${WARNING_PRELOAD}`,
    })
    expect(noisy.code).toBe(0)
    expect(noisy.stderr).toContain('CiDiagnosticWarning')          // the warning really fired
    expect(noisy.stderr).toContain('[REPORT] Project')               // human report → stderr in JSON mode
    expect(noisy.stdout).not.toContain('[REPORT]')
    expect(findingsOf(noisy)).toEqual([expect.objectContaining({ code: 'R1' })])
    // The old combined-stream parse is exactly what broke: its last line is Node's hint.
    expect(() => JSON.parse(noisy.out.trim().split('\n').at(-1))).toThrow(SyntaxError)

    // Without RECONCILE_JSON the operator still reads the report on stdout, and no JSON is printed.
    const human = run('reconcile-membership.mjs', ['--project', PROJECT_ID])
    expect(human.code).toBe(0)
    expect(human.stdout).toContain('[REPORT] Project')
    expect(human.stdout).toContain('R1  company emptyco has NO active company_admin')
    expect(human.stdout).not.toMatch(/^\[(\]|\{)/m)   // no JSON array line
  })
})

describe('revoke-file-links.mjs', () => {
  const base = ['--project', PROJECT_ID, '--bucket', 'some-bucket.firebasestorage.app']

  it('refuses to run without an explicit project, bucket and exactly one scope', () => {
    expect(run('revoke-file-links.mjs', []).code).toBe(2)
    expect(run('revoke-file-links.mjs', ['--project', PROJECT_ID, '--all-companies']).code).toBe(2)          // no bucket
    expect(run('revoke-file-links.mjs', ['--bucket', 'b-u-c', '--all-companies']).code).toBe(2)              // no project
    const noScope = run('revoke-file-links.mjs', base)
    expect(noScope.code).toBe(2)
    expect(noScope.out).toContain('exactly one scope')
    expect(run('revoke-file-links.mjs', [...base, '--company-id', COMPANY_A, '--all-companies']).code).toBe(2)
    expect(run('revoke-file-links.mjs', [...base, '--company-id', 'bad/id']).code).toBe(2)
    expect(run('revoke-file-links.mjs', [...base, '--all-companies', '--bogus']).code).toBe(2)
  })

  it('never executes without the project id repeated as confirmation', () => {
    const bare = run('revoke-file-links.mjs', [...base, '--all-companies', '--execute'])
    expect(bare.code).toBe(2)
    expect(bare.out).toContain('--execute needs --confirm-project')
    expect(run('revoke-file-links.mjs', [...base, '--all-companies', '--execute', '--confirm-project', 'another-project']).code).toBe(2)
    // A confirmation without --execute is a mistake, not a dry run.
    expect(run('revoke-file-links.mjs', [...base, '--all-companies', '--confirm-project', PROJECT_ID]).code).toBe(2)
  })

  it('refuses a key file, like every operator script', () => {
    const r = run('revoke-file-links.mjs', [...base, '--company-id', COMPANY_A], { GOOGLE_APPLICATION_CREDENTIALS: '/tmp/key.json' })
    expect(r.code).toBe(1)
    expect(r.out).toContain('never a key file')
  })
})
