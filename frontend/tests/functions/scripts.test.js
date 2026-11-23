import { afterEach, beforeAll, beforeEach, describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
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

// ── backfill-project-directory.mjs (M2-A2) ───────────────────────────────────
describe('backfill-project-directory.mjs', () => {
  const base = ['--project', PROJECT_ID]
  const START = new Date('2026-03-01T00:00:00Z')
  const display = (name) => ({ name, status: 'In Progress', location: 'Brisbane', startDate: START, progress: 40 })
  const project = (name, extra = {}) => ({ ...display(name), budget: 5000000, currency: 'AUD', currencyLocked: true, createdBy: 'u1', ...extra })
  const projects = (c = COMPANY_A) => A.db.collection('companies').doc(c).collection('projects')
  const directory = (c = COMPANY_A) => A.db.collection('companies').doc(c).collection('projectDirectory')
  const entries = async (c = COMPANY_A) => Object.fromEntries((await directory(c).get()).docs.map(d => [d.id, d.data()]))

  beforeEach(async () => { await seedCompany(COMPANY_A) })

  it('validates its arguments and refuses to run without an explicit project', () => {
    expect(run('backfill-project-directory.mjs', []).code).toBe(2)
    expect(run('backfill-project-directory.mjs', [...base, '--bogus']).code).toBe(2)
    expect(run('backfill-project-directory.mjs', [...base, '--company-id', 'bad id']).code).toBe(2)
    expect(run('backfill-project-directory.mjs', [...base, '--company-id', 'nope']).code).toBe(1)
  })

  it('is DRY-RUN BY DEFAULT: it reports the missing entries and writes nothing', async () => {
    await projects().doc('p1').set(project('One'))
    await projects().doc('p2').set(project('Two'))
    const dry = run('backfill-project-directory.mjs', base)
    expect(dry.code).toBe(0)
    expect(dry.out).toContain('[DRY RUN]')
    expect(dry.out).toContain('MISSING   companies/companyA/projects/p1 — would create its directory entry')
    expect(dry.out).toContain('Projects 2 · in sync 0 · missing 2 · invalid 0 · mismatch 0 · orphan 0 · failed 0')
    expect(dry.out).toContain('Dry run — nothing written. Re-run with --apply')
    expect(await entries()).toEqual({})
  })

  it('--apply creates exactly the five-field entries, touches no project, and is idempotent', async () => {
    await projects().doc('p1').set(project('One'))
    await projects().doc('bare').set({ name: 'Bare', budget: 0 })
    const before = (await projects().doc('p1').get()).updateTime.toMillis()

    const real = run('backfill-project-directory.mjs', [...base, '--apply'])
    expect(real.code).toBe(0)
    expect(real.out).toContain('[APPLY]')
    expect(real.out).toContain('Projects 2 · in sync 0 · missing 2 · created 2 · invalid 0 · mismatch 0 · orphan 0 · failed 0')
    const made = await entries()
    expect(Object.keys(made.p1).sort()).toEqual(['location', 'name', 'progress', 'startDate', 'status'])
    expect(made.p1).toMatchObject({ name: 'One', status: 'In Progress', location: 'Brisbane', progress: 40 })
    expect(made.p1.startDate.toMillis()).toBe(START.getTime())
    expect(made.bare).toEqual({ name: 'Bare', status: '', location: '', startDate: null, progress: 0 })
    expect(JSON.stringify(made)).not.toContain('5000000')
    expect((await projects().doc('p1').get()).updateTime.toMillis()).toBe(before)

    const again = run('backfill-project-directory.mjs', [...base, '--apply'])
    expect(again.code).toBe(0)
    expect(again.out).toContain('Projects 2 · in sync 2 · missing 0 · created 0')
    expect(await entries()).toEqual(made)
  })

  it('REFUSES a mismatched existing entry — never overwrites it — and exits non-zero', async () => {
    await projects().doc('p1').set(project('One'))
    await directory().doc('p1').set({ ...display('Stale name') })
    await projects().doc('p2').set(project('Two'))
    await directory().doc('p2').set({ ...display('Two'), budget: 5000000 })
    const real = run('backfill-project-directory.mjs', [...base, '--apply'])
    expect(real.code).toBe(1)
    expect(real.out).toContain('MISMATCH  companies/companyA/projects/p1 — name differs from the project (refused; never overwritten)')
    expect(real.out).toContain('MISMATCH  companies/companyA/projects/p2 — unexpected key "budget"')
    expect((await entries()).p1.name).toBe('Stale name')
    expect((await entries()).p2.budget).toBe(5000000)
  })

  it('REFUSES a project whose source values have the wrong type, and still creates the sound ones', async () => {
    await projects().doc('good').set(project('Good'))
    await projects().doc('badDate').set(project('Bad date', { startDate: '2026-03-01' }))
    await projects().doc('badName').set(project('x', { name: 42, progress: '40' }))
    const dry = run('backfill-project-directory.mjs', base)
    expect(dry.code).toBe(1)
    expect(dry.out).toContain('INVALID   companies/companyA/projects/badDate — startDate is a string, expected a Timestamp or null')
    const real = run('backfill-project-directory.mjs', [...base, '--apply'])
    expect(real.code).toBe(1)
    expect(real.out).toContain('invalid 2')
    expect(Object.keys(await entries())).toEqual(['good'])
  })

  it('reports an orphan entry and leaves it alone', async () => {
    await directory().doc('ghost').set(display('Ghost'))
    const real = run('backfill-project-directory.mjs', [...base, '--apply'])
    expect(real.code).toBe(1)
    expect(real.out).toContain('ORPHAN    companies/companyA/projectDirectory/ghost')
    expect(Object.keys(await entries())).toEqual(['ghost'])
  })

  it('--company-id limits the run to one company', async () => {
    await seedCompany('companyB')
    await projects().doc('p1').set(project('One'))
    await projects('companyB').doc('pb').set(project('B one'))
    const real = run('backfill-project-directory.mjs', [...base, '--company-id', 'companyB', '--apply'])
    expect(real.code).toBe(0)
    expect(await entries()).toEqual({})
    expect(Object.keys(await entries('companyB'))).toEqual(['pb'])
  })
})

// ── M2-A2 Stage B (ADR-84) — the two external-member scripts ────────────────

const project = (companyId, id) => A.db.collection('companies').doc(companyId).collection('projects').doc(id)
const seedProjects = async (companyId, ids, { directory = true } = {}) => {
  for (const id of ids) {
    const shared = { name: `Project ${id}`, status: 'active', location: '', startDate: null, progress: 0 }
    await project(companyId, id).set({ ...shared, budget: 1000 })
    if (directory) await A.db.collection('companies').doc(companyId).collection('projectDirectory').doc(id).set(shared)
  }
}
const invitationsOf = (companyId) => A.db.collection('companies').doc(companyId).collection('invitations').get().then(s => s.docs.map(d => ({ id: d.id, ...d.data() })))
const auditTypes = (companyId) => A.db.collection('companies').doc(companyId).collection('auditEvents').get().then(s => s.docs.map(d => d.data().type).sort())
// Nothing that could be an acceptance link or its token.
const expectNoCredential = (text) => {
  expect(text).not.toMatch(/accept-invite/)
  expect(text).not.toMatch(/[#&]t=/)
  expect(text).not.toMatch(/[A-Za-z0-9_-]{43}/)
}

describe('provision-external-member.mjs', () => {
  const base = ['--project', PROJECT_ID, '--company-id', COMPANY_A, '--email', 'Cleo@Client.test', '--role', 'client', '--project-ids', 'p2,p1']
  let dir
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'constrap-provision-'))
    await seedCompany(COMPANY_A, 'Acme Builders')
    await seedUser({ uid: 'u_admin', email: 'admin@acme.test', role: 'company_admin', companyId: COMPANY_A })
    await seedProjects(COMPANY_A, ['p1'])
    await seedProjects(COMPANY_A, ['p2'], { directory: false })
    await seedCompany('otherco', 'Other Co')
    await seedProjects('otherco', ['pB'])
  })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('validates its arguments: explicit project, an external role, a clean id list, and exactly one delivery with --apply', () => {
    expect(run('provision-external-member.mjs', []).code).toBe(2)
    expect(run('provision-external-member.mjs', base.slice(2)).code).toBe(2)                                     // no --project
    for (const role of ['qs', 'company_admin', 'super_admin', 'Client']) {
      expect(run('provision-external-member.mjs', [...base.slice(0, 7), role, ...base.slice(8)]).code, role).toBe(2)
    }
    for (const ids of ['p1,,p2', 'p1,', 'a/b', 'p1 p2']) expect(run('provision-external-member.mjs', [...base.slice(0, 9), ids]).code, ids).toBe(2)
    expect(run('provision-external-member.mjs', [...base, '--bogus']).code).toBe(2)
    const neither = run('provision-external-member.mjs', [...base, '--apply'])
    expect(neither.code).toBe(2)
    expect(neither.out).toContain('exactly one of --no-link or --link-file')
    expect(run('provision-external-member.mjs', [...base, '--apply', '--no-link', '--link-file', join(dir, 'l.txt')]).code).toBe(2)
    expect(run('provision-external-member.mjs', [...base, '--no-link']).code).toBe(2)                             // delivery without --apply
    expect(run('provision-external-member.mjs', [...base, '--link-file', join(dir, 'l.txt')]).code).toBe(2)
  })

  it('refuses a link file inside the repository, one that exists, a missing folder and a missing origin — before anything is written', async () => {
    const inRepo = run('provision-external-member.mjs', [...base, '--apply', '--link-file', resolve(FUNCTIONS, 'link.txt')])
    expect(inRepo.code).toBe(2)
    expect(inRepo.out).toContain('OUTSIDE this repository')
    expect(existsSync(resolve(FUNCTIONS, 'link.txt'))).toBe(false)
    const existing = join(dir, 'existing.txt')
    writeFileSync(existing, 'keep me')
    expect(run('provision-external-member.mjs', [...base, '--apply', '--link-file', existing]).code).toBe(2)
    expect(readFileSync(existing, 'utf8')).toBe('keep me')
    expect(run('provision-external-member.mjs', [...base, '--apply', '--link-file', join(dir, 'no-such-folder', 'l.txt')]).code).toBe(2)
    expect(run('provision-external-member.mjs', [...base, '--apply', '--link-file', join(dir, 'l.txt')], { APP_BASE_URL: '' }).code).toBe(2)
    expect(await invitationsOf(COMPANY_A)).toEqual([])
  })

  it('refuses a key file, like every operator script', () => {
    const r = run('provision-external-member.mjs', base, { GOOGLE_APPLICATION_CREDENTIALS: '/tmp/key.json' })
    expect(r.code).toBe(1)
    expect(r.out).toContain('never a key file')
  })

  it('is DRY-RUN BY DEFAULT: it reports the plan, warns about a missing directory entry and writes nothing', async () => {
    const dry = run('provision-external-member.mjs', base)
    expect(dry.code).toBe(0)
    expect(dry.out).toContain('DRY RUN')
    expect(dry.out).toContain('company "Acme Builders" exists')
    expect(dry.out).toContain('cleo@client.test — no account yet')
    expect(dry.out).toContain('2 project(s), all found in this company: p1, p2')
    expect(dry.out).toContain('no project-directory entry for: p2')
    expect(dry.out).toContain('nothing written')
    expect(await invitationsOf(COMPANY_A)).toEqual([])
    expect(await auditTypes(COMPANY_A)).toEqual([])
    expect((await A.auth.listUsers()).users.map(u => u.email)).toEqual(['admin@acme.test'])
  })

  it('--apply --no-link creates the invitation and keeps no link anywhere; a Company Admin\'s Resend then delivers it', async () => {
    const r = run('provision-external-member.mjs', [...base, '--apply', '--no-link'])
    expect(r.code).toBe(0)
    expectNoCredential(r.out)
    expect(r.out).toContain('presses Resend for cleo@client.test')
    const [inv] = await invitationsOf(COMPANY_A)
    expect(inv).toMatchObject({ email: 'cleo@client.test', role: 'client', projectIds: ['p1', 'p2'], status: 'pending', deliveredVia: 'operator', createdBy: 'operator' })
    expect(r.out).toContain(`invitation ${inv.id} created`)
    expect(r.out).not.toContain(inv.tokenHash)
    expect(await auditTypes(COMPANY_A)).toEqual(['invite.created'])
    // No account and no membership were created.
    expect((await A.auth.listUsers()).users.map(u => u.email)).toEqual(['admin@acme.test'])
    expect((await A.db.collection('users').get()).size).toBe(1)

    const { handlers: H, mailer } = await makeHandlers()
    await H.resendInvitation(req('u_admin', { inviteId: inv.id }))
    expect(mailer.sent[0].to).toBe('cleo@client.test')
    await A.auth.createUser({ uid: 'u_cleo', email: 'cleo@client.test', password: 'correct-horse-battery' })
    await H.acceptInvitation(req('u_cleo', parseLink(mailer.lastLink())))
    expect((await A.db.collection('users').doc('u_cleo').get()).data()).toMatchObject({ role: 'client', companyId: COMPANY_A, projectIds: ['p1', 'p2'] })

    // A second run for an email that already holds a pending invitation is
    // refused: nothing is rotated or duplicated.
    const again = run('provision-external-member.mjs', [...base.slice(0, 5), 'sam@sub.test', ...base.slice(6), '--apply', '--no-link'])
    expect(again.code).toBe(0)
    const dup = run('provision-external-member.mjs', [...base.slice(0, 5), 'sam@sub.test', ...base.slice(6), '--apply', '--no-link'])
    expect(dup.code).toBe(1)
    expect(dup.out).toContain('Refused: invite-pending')
    expect((await invitationsOf(COMPANY_A)).filter(i => i.email === 'sam@sub.test')).toHaveLength(1)
  })

  it('--apply --link-file writes the link to a NEW 0600 file and never to the console', async () => {
    const file = join(dir, 'cleo-link.txt')
    const r = run('provision-external-member.mjs', [...base.slice(0, 7), 'subcontractor', ...base.slice(8), '--apply', '--link-file', file])
    expect(r.code).toBe(0)
    expectNoCredential(r.out)
    expect(r.out).toContain(`The acceptance link is in ${file} (mode 0600)`)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    const link = readFileSync(file, 'utf8').trim()
    expect(link.startsWith('http://localhost:5173/accept-invite#')).toBe(true)
    expect(r.out).not.toContain(parseLink(link).token)

    const { handlers: H } = await makeHandlers()
    expect(await H.previewInvitation(req(null, parseLink(link)))).toMatchObject({ email: 'cleo@client.test', role: 'subcontractor', accountState: 'new' })
    await A.auth.createUser({ uid: 'u_cleo', email: 'cleo@client.test', password: 'correct-horse-battery' })
    await H.acceptInvitation(req('u_cleo', parseLink(link)))
    expect((await A.db.collection('users').doc('u_cleo').get()).data()).toMatchObject({ role: 'subcontractor', projectIds: ['p1', 'p2'] })
    expect((await A.auth.getUser('u_cleo')).emailVerified).toBe(false)
  })

  it('a refusal exits 1, names its reason, writes nothing and leaves no link file', async () => {
    const file = join(dir, 'refused.txt')
    const cases = [
      [[...base.slice(0, 9), 'p1,nope'], 'invalid-assignment — project-not-found · project id(s): nope'],
      [[...base.slice(0, 9), 'p1,pB'], 'invalid-assignment — project-not-found · project id(s): pB'],          // another company's project
      [[...base.slice(0, 9), 'p1,p1'], 'invalid-assignment — duplicate'],
      [[...base.slice(0, 9), Array.from({ length: 31 }, (_, i) => `q${i}`).join(',')], 'invalid-assignment — too-many'],
      [[...base.slice(0, 3), 'ghostco', ...base.slice(4)], 'not-found'],
      [[...base.slice(0, 5), 'admin@acme.test', ...base.slice(6)], 'already-member'],
    ]
    for (const [args, message] of cases) {
      for (const mode of [[], ['--apply', '--link-file', file]]) {
        const r = run('provision-external-member.mjs', [...args, ...mode])
        expect(r.code, message).toBe(1)
        expect(r.out, message).toContain(`Refused: ${message}`)
        expect(existsSync(file), message).toBe(false)
      }
    }
    expect(await invitationsOf(COMPANY_A)).toEqual([])
    expect(await auditTypes(COMPANY_A)).toEqual([])
  })
})

describe('set-member-projects.mjs', () => {
  const base = ['--project', PROJECT_ID, '--company-id', COMPANY_A]
  const profile = (uid) => A.db.collection('users').doc(uid).get().then(s => s.data())
  beforeEach(async () => {
    await seedCompany(COMPANY_A, 'Acme Builders')
    await seedUser({ uid: 'u_admin', email: 'admin@acme.test', role: 'company_admin', companyId: COMPANY_A })
    await seedUser({ uid: 'u_qs', email: 'qs@acme.test', role: 'qs', companyId: COMPANY_A })
    await seedUser({ uid: 'u_cleo', email: 'cleo@client.test', role: 'client', companyId: COMPANY_A })
    await A.db.collection('users').doc('u_cleo').update({ projectIds: ['p1', 'p2'] })
    await seedProjects(COMPANY_A, ['p1', 'p2', 'p3'])
  })

  it('validates its arguments: one member, one kind of change, an explicit project', () => {
    expect(run('set-member-projects.mjs', []).code).toBe(2)
    expect(run('set-member-projects.mjs', ['--company-id', COMPANY_A, '--uid', 'u_cleo', '--add', 'p3']).code).toBe(2)   // no --project
    expect(run('set-member-projects.mjs', [...base, '--add', 'p3']).code).toBe(2)                                        // no member
    expect(run('set-member-projects.mjs', [...base, '--uid', 'u_cleo', '--email', 'cleo@client.test', '--add', 'p3']).code).toBe(2)
    expect(run('set-member-projects.mjs', [...base, '--uid', 'u_cleo']).code).toBe(2)                                    // no change
    expect(run('set-member-projects.mjs', [...base, '--uid', 'u_cleo', '--set', 'p1', '--add', 'p3']).code).toBe(2)
    expect(run('set-member-projects.mjs', [...base, '--uid', 'u_cleo', '--set', 'p1', '--clear']).code).toBe(2)
    expect(run('set-member-projects.mjs', [...base, '--uid', 'u_cleo', '--clear', '--remove', 'p1']).code).toBe(2)
    expect(run('set-member-projects.mjs', [...base, '--uid', 'u_cleo', '--add', 'p1,,p2']).code).toBe(2)
    expect(run('set-member-projects.mjs', [...base, '--uid', 'u_cleo', '--set', '']).code).toBe(2)
    expect(run('set-member-projects.mjs', [...base, '--uid', 'u_cleo', '--add', 'p3'], { GOOGLE_APPLICATION_CREDENTIALS: '/tmp/key.json' }).code).toBe(1)
  })

  it('is DRY-RUN BY DEFAULT: it shows the change and writes nothing', async () => {
    const dry = run('set-member-projects.mjs', [...base, '--email', 'Cleo@Client.test', '--add', 'p3', '--remove', 'p1'])
    expect(dry.code).toBe(0)
    expect(dry.out).toContain('DRY RUN')
    expect(dry.out).toContain('member u_cleo (cleo@client.test) — active client')
    expect(dry.out).toContain('projects now:   p1, p2')
    expect(dry.out).toContain('projects after: p2, p3')
    expect(dry.out).toContain('Applying would also queue a file-link revocation')
    expect((await profile('u_cleo')).projectIds).toEqual(['p1', 'p2'])
    expect(await auditTypes(COMPANY_A)).toEqual([])
    expect((await A.db.collection('companies').doc(COMPANY_A).collection('system').get()).empty).toBe(true)
  })

  it('--apply writes the list, one audit event and — for a removal — a revocation request, with the honest warning', async () => {
    const added = run('set-member-projects.mjs', [...base, '--uid', 'u_cleo', '--add', 'p3', '--apply'])
    expect(added.code).toBe(0)
    expect(added.out).not.toContain('revocation queued')
    expect((await profile('u_cleo')).projectIds).toEqual(['p1', 'p2', 'p3'])
    expect(await auditTypes(COMPANY_A)).toEqual(['member.projects_changed'])

    const removed = run('set-member-projects.mjs', [...base, '--uid', 'u_cleo', '--set', 'p3', '--apply'])
    expect(removed.code).toBe(0)
    expect(removed.out).toContain('File-link revocation queued (request 1)')
    expect(removed.out).toContain('may keep working until the sweep completes')
    expect((await profile('u_cleo')).projectIds).toEqual(['p3'])
    expect(await auditTypes(COMPANY_A)).toEqual(['file_links.revocation_requested', 'member.projects_changed', 'member.projects_changed'])
    const state = (await A.db.collection('companies').doc(COMPANY_A).collection('system').doc('fileLinkRevocation').get()).data()
    expect(state).toMatchObject({ requestSeq: 1, requestReason: 'member.assignment_removed', requestedBy: 'operator' })

    // Repeating it is safe.
    const again = run('set-member-projects.mjs', [...base, '--uid', 'u_cleo', '--set', 'p3', '--apply'])
    expect(again.code).toBe(0)
    expect(again.out).toContain('No change')
    expect((await auditTypes(COMPANY_A))).toHaveLength(3)

    const cleared = run('set-member-projects.mjs', [...base, '--uid', 'u_cleo', '--clear', '--apply'])
    expect(cleared.code).toBe(0)
    expect(cleared.out).toContain('will hold NO project')
    expect(await profile('u_cleo')).toMatchObject({ projectIds: [], role: 'client', companyId: COMPANY_A })
  })

  it('refuses an internal member, an unknown member and a project of another company — exit 1, nothing written', async () => {
    await seedCompany('otherco', 'Other Co')
    await seedProjects('otherco', ['pB'])
    const internal = run('set-member-projects.mjs', [...base, '--uid', 'u_qs', '--add', 'p1', '--apply'])
    expect(internal.code).toBe(1)
    expect(internal.out).toContain('Refused: invalid-assignment — role')
    expect('projectIds' in (await profile('u_qs'))).toBe(false)
    const unknown = run('set-member-projects.mjs', [...base, '--email', 'nobody@client.test', '--add', 'p1', '--apply'])
    expect(unknown.code).toBe(1)
    expect(unknown.out).toContain('Refused: not-found')
    const foreign = run('set-member-projects.mjs', [...base, '--uid', 'u_cleo', '--add', 'pB', '--apply'])
    expect(foreign.code).toBe(1)
    expect(foreign.out).toContain('Refused: invalid-assignment — project-not-found · project id(s): pB')
    expect((await profile('u_cleo')).projectIds).toEqual(['p1', 'p2'])
    expect(await auditTypes(COMPANY_A)).toEqual([])
  })
})

describe('reconcile-membership.mjs — project assignments (ADR-84)', () => {
  it('reports an assignment held by an internal or removed profile and a broken external one; --fix removes only the first two kinds', async () => {
    await seedCompany(COMPANY_A, 'Acme Builders')
    await seedProjects(COMPANY_A, ['p1'])
    await seedUser({ uid: 'u_admin', email: 'admin@acme.test', role: 'company_admin', companyId: COMPANY_A })
    await seedUser({ uid: 'u_qs', email: 'qs@acme.test', role: 'qs', companyId: COMPANY_A })
    await seedUser({ uid: 'u_ok', email: 'ok@client.test', role: 'client', companyId: COMPANY_A })
    await seedUser({ uid: 'u_bad', email: 'bad@client.test', role: 'subcontractor', companyId: COMPANY_A })
    await seedUser({ uid: 'u_odd', email: 'odd@client.test', role: 'client', companyId: COMPANY_A })
    await seedUser({ uid: 'u_gone', email: 'gone@client.test', role: 'client', companyId: COMPANY_A })
    const users = A.db.collection('users')
    await users.doc('u_qs').update({ projectIds: ['p1'] })                  // R7 — internal role
    await users.doc('u_ok').update({ projectIds: ['p1'] })                  // sound: no finding
    await users.doc('u_bad').update({ projectIds: ['p1', 'missing'] })      // R9 — a project that does not exist
    await users.doc('u_odd').update({ projectIds: 'p1' })                   // R9 — not a list
    await users.doc('u_gone').update({ projectIds: ['p1'], companyId: null, role: null, status: 'deactivated', formerCompanyId: COMPANY_A, formerRole: 'client', authSyncPending: false })

    const report = run('reconcile-membership.mjs', ['--project', PROJECT_ID], { RECONCILE_JSON: '1' })
    expect(report.code).toBe(0)
    expect(findingsOf(report).map(f => f.code).sort()).toEqual(['R7', 'R8', 'R9', 'R9'])
    expect((await users.doc('u_qs').get()).data().projectIds).toEqual(['p1'])   // report only

    const fixed = run('reconcile-membership.mjs', ['--project', PROJECT_ID, '--fix'], { RECONCILE_JSON: '1' })
    expect(fixed.code).toBe(0)
    expect('projectIds' in (await users.doc('u_qs').get()).data()).toBe(false)
    expect('projectIds' in (await users.doc('u_gone').get()).data()).toBe(false)
    expect((await users.doc('u_ok').get()).data().projectIds).toEqual(['p1'])
    expect((await users.doc('u_bad').get()).data().projectIds).toEqual(['p1', 'missing'])   // a person decides
    expect((await users.doc('u_odd').get()).data().projectIds).toBe('p1')
    const fixes = (await A.db.collection('companies').doc(COMPANY_A).collection('auditEvents').get()).docs.map(d => d.data()).filter(e => e.type === 'reconcile.fix')
    expect(fixes.map(e => e.targetUid).sort()).toEqual(['u_gone', 'u_qs'])
    expect(fixes.every(e => e.after.fix === 'F2' && e.before.projectIds.join() === 'p1')).toBe(true)

    const after = run('reconcile-membership.mjs', ['--project', PROJECT_ID], { RECONCILE_JSON: '1' })
    expect(findingsOf(after).map(f => f.code).sort()).toEqual(['R9', 'R9'])
  })
})
