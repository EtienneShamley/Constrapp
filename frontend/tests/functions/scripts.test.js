import { afterEach, beforeAll, beforeEach, describe, it, expect } from 'vitest'
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
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
const REFUSE_TRANSACTION = resolve(HERE, 'fixtures/refuse-transaction.mjs')
const FAIL_LINK_WRITE = resolve(HERE, 'fixtures/fail-link-write.mjs')

const lockRef = (companyId) => A.db.collection('companies').doc(companyId).collection('system').doc('membership')
// True when a one-attempt transaction can write the document straight away.
// A transaction left open by a script that exited before its rollback went
// out keeps the document locked: the emulator then answers ABORTED
// ("Transaction lock timeout") after ~2 s, and keeps the lock for about a
// minute.
async function writableAtOnce(ref) {
  const started = Date.now()
  try {
    await A.db.runTransaction(async (tx) => { await tx.get(ref); tx.set(ref, { lifecycleProbe: started }, { merge: true }) }, { maxAttempts: 1 })
  } catch (e) {
    if (/lock timeout/i.test(e?.message ?? '')) return false
    throw e
  }
  return Date.now() - started < 1500
}

let A
beforeAll(async () => { A = await admin() })
beforeEach(async () => { await resetEmulators() })

describe('bootstrap-company.mjs', () => {
  const base = ['--project', PROJECT_ID, '--company-id', 'acme', '--company-name', 'Acme Builders', '--admin-email', 'Ada@Acme.test', '--country', 'AU', '--currency', 'AUD']
  let dir
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'constrap-bootstrap-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  // Everything the script could write: the company and its subcollections, and Auth.
  const footprint = async () => {
    const companies = (await A.db.collection('companies').get()).docs.map(d => d.id).sort()
    const sub = {}
    for (const c of companies) {
      for (const coll of ['invitations', 'auditEvents', 'system', 'members']) {
        const s = await A.db.collection('companies').doc(c).collection(coll).get()
        if (s.size) sub[`${c}/${coll}`] = s.docs.map(d => `${d.id}:${d.updateTime.toMillis()}`).sort()
      }
    }
    return { companies, sub, users: (await A.db.collection('users').get()).size, auth: (await A.auth.listUsers()).users.length }
  }
  const EMPTY = { companies: [], sub: {}, users: 0, auth: 0 }
  const linkOf = (file) => readFileSync(file, 'utf8').trim()
  const applyTo = (file, extra = []) => [...base, '--apply', '--link-file', file, ...extra]

  it('validates its arguments and refuses to run without an explicit project — with nothing written', async () => {
    const usageCases = [
      [],
      ['--project', PROJECT_ID, '--company-id', 'Bad Id', '--company-name', 'x', '--admin-email', 'a@b.co'],
      [...base, '--bogus'],
      base.slice(2),                                                           // no --project
      [...base, '--apply'],                                                    // no delivery option
      [...base, '--apply', '--dry-run', '--no-link'],                          // contradictory execution flags
      [...base, '--apply', '--no-link', '--link-file', join(dir, 'l.txt')],    // two delivery options
      [...base, '--no-link'],                                                  // delivery without --apply
      [...base, '--link-file', join(dir, 'l.txt')],
      [...base, '--dry-run', '--link-file', join(dir, 'l.txt')],
      [...base, '--apply', '--no-link', '--app-url', 'http://localhost:5173'], // origin is meaningless without a file
      [...base, '--apply', '--link-file', join(dir, 'l.txt'), '--app-url', 'http://localhost:5173/path'],
    ]
    for (const args of usageCases) {
      const r = run('bootstrap-company.mjs', args)
      expect(r.code, args.join(' ')).toBe(2)
      expectNoCredential(r.out)
    }
    expect(run('bootstrap-company.mjs', [...base, '--apply', '--no-link'], { GOOGLE_APPLICATION_CREDENTIALS: '/tmp/key.json' }).code).toBe(1)
    expect(await footprint()).toEqual(EMPTY)
  })

  it('is DRY-RUN BY DEFAULT: no flag, --dry-run, and the old write command all read only', async () => {
    for (const args of [base, [...base, '--dry-run'], [...base, '--app-url', 'http://localhost:5173'], [...base, '--rotate']]) {
      const r = run('bootstrap-company.mjs', args)
      if (args.includes('--rotate')) {
        expect(r.code).toBe(1)                     // nothing to rotate — still read-only
        expect(r.out).toContain('no pending invitation')
      } else {
        expect(r.code, args.join(' ')).toBe(0)
        expect(r.out).toContain('[DRY RUN — read only]')
        expect(r.out).toContain('would create companies/acme')
        expect(r.out).toContain('would create an operator-delivered company_admin invitation for ada@acme.test')
        expect(r.out).toContain('Dry run — nothing written. Re-run with --apply and exactly one of --no-link or --link-file <path>.')
      }
      expectNoCredential(r.out)
    }
    expect(await footprint()).toEqual(EMPTY)
    // The dry run of an existing company with a pending invitation is read-only too.
    run('bootstrap-company.mjs', [...base, '--apply', '--no-link'])
    const before = await footprint()
    const dry = run('bootstrap-company.mjs', [...base, '--rotate'])
    expect(dry.code).toBe(0)
    expect(dry.out).toContain('would ROTATE the pending invitation')
    expect(await footprint()).toEqual(before)
  })

  it('--apply --link-file creates the company, an operator invitation and its audit; the link reaches only a new 0600 file', async () => {
    const file = join(dir, 'ada-link.txt')
    const real = run('bootstrap-company.mjs', applyTo(file))
    expect(real.code).toBe(0)
    expectNoCredential(real.out)
    expect(real.out).toContain(`The acceptance link is in ${file} (mode 0600). It is NOT shown here.`)
    const st = statSync(file)
    expect(st.mode & 0o777).toBe(0o600)
    expect(st.isFile() && st.nlink === 1).toBe(true)
    const link = linkOf(file)
    expect(link.startsWith('http://localhost:5173/accept-invite#')).toBe(true)
    const cred = parseLink(link)
    expect(real.out).not.toContain(cred.token)

    const company = await A.db.collection('companies').doc('acme').get()
    expect(company.data()).toMatchObject({ name: 'Acme Builders', countryCode: 'AU', baseCurrency: 'AUD', createdBy: 'operator' })
    const inv = await A.db.collection('companies').doc('acme').collection('invitations').doc(cred.inviteId).get()
    expect(inv.data()).toMatchObject({ email: 'ada@acme.test', role: 'company_admin', status: 'pending', deliveredVia: 'operator', createdBy: 'operator' })
    expect(real.out).toContain(`invitation ${cred.inviteId} created`)
    expect(real.out).not.toContain(inv.data().tokenHash)
    expect(await auditTypes('acme')).toEqual(['company.bootstrapped', 'invite.created'])

    // The file's link is a working invitation; acceptance makes the first admin.
    const { handlers: H } = await makeHandlers()
    expect((await H.previewInvitation(req(null, cred))).accountState).toBe('new')
    await A.auth.createUser({ uid: 'u_ada', email: 'ada@acme.test', password: 'correct-horse-battery' })
    await H.acceptInvitation(req('u_ada', cred))
    expect((await A.db.collection('users').doc('u_ada').get()).data()).toMatchObject({ companyId: 'acme', role: 'company_admin' })
    expect((await A.auth.getUser('u_ada')).emailVerified).toBe(false)   // operator link proves no mailbox

    // Idempotent: re-running reports nothing to do and creates no file; a different name is refused.
    const before = await footprint()
    const again = run('bootstrap-company.mjs', applyTo(join(dir, 'again.txt')))
    expect(again.code).toBe(0)
    expect(again.out).toContain('already an active Company Admin')
    expect(existsSync(join(dir, 'again.txt'))).toBe(false)
    const renamed = run('bootstrap-company.mjs', [...base.slice(0, 5), 'Other Name', ...base.slice(6), '--apply', '--link-file', join(dir, 'renamed.txt')])
    expect(renamed.code).toBe(1)
    expect(renamed.out).toContain('Refusing an ambiguous change')
    expect(existsSync(join(dir, 'renamed.txt'))).toBe(false)
    expect(await footprint()).toEqual(before)
  })

  it('--apply --no-link keeps no link anywhere; the invitation is delivered later by an explicit --rotate --link-file', async () => {
    const r = run('bootstrap-company.mjs', [...base, '--apply', '--no-link'])
    expect(r.code).toBe(0)
    expectNoCredential(r.out)
    expect(r.out).toContain('No link was kept')
    expect(readdirSync(dir)).toEqual([])
    const [inv] = await invitationsOf('acme')
    expect(inv).toMatchObject({ email: 'ada@acme.test', role: 'company_admin', status: 'pending', deliveredVia: 'operator' })

    const file = join(dir, 'later.txt')
    const later = run('bootstrap-company.mjs', applyTo(file, ['--rotate']))
    expect(later.code).toBe(0)
    expectNoCredential(later.out)
    expect(parseLink(linkOf(file)).inviteId).toBe(inv.id)
    const after = await invitationsOf('acme')
    expect(after).toHaveLength(1)
    expect(after[0].tokenHash).not.toBe(inv.tokenHash)
    expect(after[0].previousTokenHash).toBe(inv.tokenHash)
    expect(await auditTypes('acme')).toEqual(['company.bootstrapped', 'invite.created', 'invite.resent'])
    const { handlers: H } = await makeHandlers()
    expect((await H.previewInvitation(req(null, parseLink(linkOf(file))))).accountState).toBe('new')
  })

  it('never replaces a pending invitation silently: a re-run is refused unless --rotate, which keeps one invitation and kills the old link', async () => {
    const f1 = join(dir, 'one.txt'), f2 = join(dir, 'two.txt'), f3 = join(dir, 'three.txt')
    expect(run('bootstrap-company.mjs', applyTo(f1)).code).toBe(0)
    const link1 = linkOf(f1)
    const before = await footprint()

    const plain = run('bootstrap-company.mjs', applyTo(f2))
    expect(plain.code).toBe(1)
    expect(plain.out).toContain(`a pending company_admin invitation ${parseLink(link1).inviteId} already exists`)
    expect(existsSync(f2)).toBe(false)
    expect(await footprint()).toEqual(before)

    const rotated = run('bootstrap-company.mjs', applyTo(f3, ['--rotate']))
    expect(rotated.code).toBe(0)
    expect(rotated.out).toContain(`invitation ${parseLink(link1).inviteId} rotated`)
    const link3 = linkOf(f3)
    expect(parseLink(link3).inviteId).toBe(parseLink(link1).inviteId)
    expect(parseLink(link3).token).not.toBe(parseLink(link1).token)
    expect(await invitationsOf('acme')).toHaveLength(1)
    const { handlers: H, CODE } = { ...(await makeHandlers()), CODE: A.CODE }
    await expect(H.previewInvitation(req(null, parseLink(link1)))).rejects.toMatchObject({ details: { code: CODE.INVALID_INVITATION } })
    expect((await H.previewInvitation(req(null, parseLink(link3)))).accountState).toBe('new')
  })

  it('--rotate refuses a pending invitation for another role, and an apply with nothing to rotate', async () => {
    await seedCompany('acme', 'Acme Builders')
    await seedUser({ uid: 'u_admin', email: 'boss@acme.test', role: 'company_admin', companyId: 'acme' })
    const { handlers: H } = await makeHandlers()
    await H.createInvitation(req('u_admin', { email: 'ada@acme.test', role: 'project_manager' }))
    const before = await footprint()
    for (const extra of [[], ['--rotate']]) {
      const r = run('bootstrap-company.mjs', applyTo(join(dir, 'pm.txt'), extra))
      expect(r.code).toBe(1)
      expect(r.out).toContain('is for the role project_manager, not company_admin')
      expect(existsSync(join(dir, 'pm.txt'))).toBe(false)
    }
    expect(await footprint()).toEqual(before)
    const none = run('bootstrap-company.mjs', [...base.slice(0, 7), 'nobody@acme.test', ...base.slice(8), '--apply', '--no-link', '--rotate'])
    expect(none.code).toBe(1)
    expect(none.out).toContain('there is no pending invitation for nobody@acme.test to rotate')
    expect(await footprint()).toEqual(before)
  })

  it('refuses an unsafe link destination before anything is written: repository, existing file, symbolic links, missing or shared folder', async () => {
    const existing = join(dir, 'existing.txt')
    writeFileSync(existing, 'keep me')
    const target = join(dir, 'target.txt')
    writeFileSync(target, 'target')
    symlinkSync(target, join(dir, 'to-file.txt'))
    symlinkSync(join(dir, 'nowhere.txt'), join(dir, 'dangling.txt'))
    symlinkSync(FUNCTIONS, join(dir, 'repo-alias'))                          // a folder link INTO the repository
    const shared = join(dir, 'shared')
    mkdirSync(shared)
    chmodSync(shared, 0o777)
    const cases = [
      [resolve(FUNCTIONS, 'link.txt'), 'OUTSIDE this repository'],
      [join(dir, 'repo-alias', 'link.txt'), 'OUTSIDE this repository'],
      [existing, 'already exists'],
      [join(dir, 'to-file.txt'), 'already exists'],
      [join(dir, 'dangling.txt'), 'already exists'],
      [join(dir, 'no-such-folder', 'l.txt'), 'the folder does not exist'],
      [join(shared, 'l.txt'), 'writable by other users'],
    ]
    for (const [file, message] of cases) {
      const r = run('bootstrap-company.mjs', applyTo(file))
      expect(r.code, file).toBe(2)
      expect(r.out, file).toContain(message)
    }
    expect(run('bootstrap-company.mjs', applyTo(join(dir, 'l.txt')), { APP_BASE_URL: '' }).code).toBe(2)   // no origin
    expect(readFileSync(existing, 'utf8')).toBe('keep me')
    expect(readFileSync(target, 'utf8')).toBe('target')
    expect(lstatSync(join(dir, 'dangling.txt')).isSymbolicLink()).toBe(true)
    expect(existsSync(join(dir, 'nowhere.txt'))).toBe(false)
    expect(existsSync(resolve(FUNCTIONS, 'link.txt'))).toBe(false)
    expect(readdirSync(shared)).toEqual([])
    expect(await footprint()).toEqual(EMPTY)
  })

  it('two runs racing for one link file: exactly one writes it, the other writes nothing anywhere', async () => {
    const file = join(dir, 'race.txt')
    const spawnRun = (companyId) => new Promise((res) => {
      const args = ['--project', PROJECT_ID, '--company-id', companyId, '--company-name', `Co ${companyId}`, '--admin-email', `ada@${companyId}.test`, '--apply', '--link-file', file]
      const ch = spawn(process.execPath, [resolve(FUNCTIONS, 'scripts/bootstrap-company.mjs'), ...args], {
        cwd: FUNCTIONS, env: { ...process.env, APP_BASE_URL: 'http://localhost:5173', GOOGLE_APPLICATION_CREDENTIALS: '' },
      })
      let out = ''
      ch.stdout.on('data', (d) => { out += d }); ch.stderr.on('data', (d) => { out += d })
      ch.on('exit', (code) => res({ companyId, code, out }))
    })
    const results = await Promise.all(['race-one', 'race-two'].map(spawnRun))
    const winners = results.filter(r => r.code === 0)
    expect(winners).toHaveLength(1)
    const loser = results.find(r => r.code !== 0)
    expect([1, 2]).toContain(loser.code)
    expect(loser.out).toMatch(/already exists|appeared while being created/)
    for (const r of results) expectNoCredential(r.out)
    expect(parseLink(linkOf(file)).companyId).toBe(winners[0].companyId)
    const fp = await footprint()
    expect(fp.companies).toEqual([winners[0].companyId])
    expect(Object.keys(fp.sub).filter(k => k.startsWith(loser.companyId))).toEqual([])
  })

  it('a link file that cannot be written AFTER the commit: exit 3, the invitation is named, the partial file is removed, nothing is retried — and --rotate recovers', async () => {
    const file = join(dir, 'full-disk.txt')
    const r = run('bootstrap-company.mjs', applyTo(file), { NODE_OPTIONS: `--import=${FAIL_LINK_WRITE}` })
    expect(r.code).toBe(3)
    expectNoCredential(r.out)
    expect(existsSync(file)).toBe(false)
    const [inv] = await invitationsOf('acme')
    expect(inv).toMatchObject({ status: 'pending', email: 'ada@acme.test' })
    expect(r.out).toContain(`The invitation ${inv.id} IS CREATED, but the link could not be written to ${file} (ENOSPC)`)
    expect(r.out).toContain('the partial file was removed')
    expect(r.out).toContain('--apply --rotate --link-file')

    // Recovery: a plain re-run is refused (no duplicate, no silent rotation) …
    const plain = run('bootstrap-company.mjs', applyTo(join(dir, 'retry.txt')))
    expect(plain.code).toBe(1)
    expect(await invitationsOf('acme')).toEqual([inv])
    // … and the explicit rotation delivers a fresh link for the same invitation.
    const recovered = join(dir, 'recovered.txt')
    expect(run('bootstrap-company.mjs', applyTo(recovered, ['--rotate'])).code).toBe(0)
    expect(parseLink(linkOf(recovered)).inviteId).toBe(inv.id)
    expect(await invitationsOf('acme')).toHaveLength(1)
    expect(await auditTypes('acme')).toEqual(['company.bootstrapped', 'invite.created', 'invite.resent'])
  })

  it('a refusal inside the invitation transaction: exit 1, nothing written, no link file, not retried, and the membership lock is free at once', async () => {
    await seedCompany('acme', 'Acme Builders')
    const file = join(dir, 'refused.txt')
    const r = run('bootstrap-company.mjs', applyTo(file), { NODE_OPTIONS: `--import=${REFUSE_TRANSACTION}` })
    expect(r.code).toBe(1)
    expect(r.out).toContain('simulated refusal inside the transaction')
    expect(r.stderr.match(/\[fixture\] transaction 1 attempt/g)).toHaveLength(1)
    expectNoCredential(r.out)
    expect(existsSync(file)).toBe(false)
    expect(await invitationsOf('acme')).toEqual([])
    expect(await auditTypes('acme')).toEqual([])
    expect((await lockRef('acme').get()).exists).toBe(false)
    expect(await writableAtOnce(lockRef('acme'))).toBe(true)

    // The same for a rotation: the old token stays, the lock is free.
    expect(run('bootstrap-company.mjs', [...base, '--apply', '--no-link']).code).toBe(0)
    const [inv] = await invitationsOf('acme')
    const rot = run('bootstrap-company.mjs', applyTo(file, ['--rotate']), { NODE_OPTIONS: `--import=${REFUSE_TRANSACTION}` })
    expect(rot.code).toBe(1)
    expect(existsSync(file)).toBe(false)
    expect(await invitationsOf('acme')).toEqual([inv])
    expect(await auditTypes('acme')).toEqual(['invite.created'])
    expect(await writableAtOnce(lockRef('acme'))).toBe(true)
  })

  it('a refusal inside the company transaction leaves no company and no audit event', async () => {
    const r = run('bootstrap-company.mjs', applyTo(join(dir, 'c.txt')), { NODE_OPTIONS: `--import=${REFUSE_TRANSACTION}` })
    expect(r.code).toBe(1)
    expect(existsSync(join(dir, 'c.txt'))).toBe(false)
    expect(await footprint()).toEqual(EMPTY)
    expect(await writableAtOnce(A.db.collection('companies').doc('acme'))).toBe(true)
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

  it('D3 #16 regression: a folder that is a symbolic link INTO the repository is refused — and so are file links and shared folders — before anything is written', async () => {
    symlinkSync(FUNCTIONS, join(dir, 'repo-alias'))                     // the reported hole: path typed outside, real path inside
    symlinkSync(resolve(FUNCTIONS, '..', '..'), join(dir, 'root-alias'))
    const target = join(dir, 'target.txt')
    writeFileSync(target, 'target')
    symlinkSync(target, join(dir, 'to-file.txt'))
    symlinkSync(join(dir, 'nowhere.txt'), join(dir, 'dangling.txt'))
    const shared = join(dir, 'shared')
    mkdirSync(shared)
    chmodSync(shared, 0o777)
    const cases = [
      [join(dir, 'repo-alias', 'leak.txt'), 'OUTSIDE this repository'],
      [join(dir, 'root-alias', 'leak.txt'), 'OUTSIDE this repository'],
      [join(dir, 'to-file.txt'), 'already exists'],
      [join(dir, 'dangling.txt'), 'already exists'],
      [join(shared, 'l.txt'), 'writable by other users'],
    ]
    for (const [file, message] of cases) {
      const r = run('provision-external-member.mjs', [...base, '--apply', '--link-file', file])
      expect(r.code, file).toBe(2)
      expect(r.out, file).toContain(message)
      expectNoCredential(r.out)
    }
    expect(existsSync(resolve(FUNCTIONS, 'leak.txt'))).toBe(false)
    expect(existsSync(resolve(FUNCTIONS, '..', '..', 'leak.txt'))).toBe(false)
    expect(readFileSync(target, 'utf8')).toBe('target')
    expect(existsSync(join(dir, 'nowhere.txt'))).toBe(false)
    expect(readdirSync(shared)).toEqual([])
    expect(await invitationsOf(COMPANY_A)).toEqual([])
    expect(await auditTypes(COMPANY_A)).toEqual([])
  })

  it('a link file that cannot be written AFTER the commit: exit 3, invitation named, partial file removed; no rotation, no duplicate; Resend recovers', async () => {
    const file = join(dir, 'full-disk.txt')
    const r = run('provision-external-member.mjs', [...base, '--apply', '--link-file', file], { NODE_OPTIONS: `--import=${FAIL_LINK_WRITE}` })
    expect(r.code).toBe(3)
    expectNoCredential(r.out)
    expect(existsSync(file)).toBe(false)
    const [inv] = await invitationsOf(COMPANY_A)
    expect(inv).toMatchObject({ email: 'cleo@client.test', role: 'client', projectIds: ['p1', 'p2'], status: 'pending', deliveredVia: 'operator' })
    expect(r.out).toContain(`The invitation ${inv.id} IS CREATED, but the link could not be written to ${file} (ENOSPC)`)
    expect(r.out).toContain('the partial file was removed')
    expect(r.out).toContain('presses Resend for cleo@client.test')
    expect(await auditTypes(COMPANY_A)).toEqual(['invite.created'])

    // A plain re-run is refused: no second invitation, no rotation.
    const again = run('provision-external-member.mjs', [...base, '--apply', '--link-file', join(dir, 'again.txt')])
    expect(again.code).toBe(1)
    expect(again.out).toContain(`Refused: invite-pending — invitation ${inv.id}`)
    expect(existsSync(join(dir, 'again.txt'))).toBe(false)
    expect(await invitationsOf(COMPANY_A)).toEqual([inv])

    // Recovery through the existing path: a Company Admin's Resend emails a fresh link.
    const { handlers: H, mailer } = await makeHandlers()
    await H.resendInvitation(req('u_admin', { inviteId: inv.id }))
    expect(mailer.sent[0].to).toBe('cleo@client.test')
    expect(parseLink(mailer.lastLink()).inviteId).toBe(inv.id)
    expect(await invitationsOf(COMPANY_A)).toHaveLength(1)
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

describe('set-client-finance.mjs (ADR-89 — company activation of client credit notes and retention releases)', () => {
  const base = ['--project', PROJECT_ID, '--company', COMPANY_A]
  const companyDoc = (c = COMPANY_A) => A.db.collection('companies').doc(c).get().then(s => s.data())
  const events = (c = COMPANY_A) => A.db.collection('companies').doc(c).collection('auditEvents').get().then(s => s.docs.map(d => d.data()))
  const SEEDED = { name: 'Acme Builders', countryCode: 'AU', baseCurrency: 'AUD' }
  beforeEach(async () => {
    await seedCompany(COMPANY_A, 'Acme Builders')
    await seedCompany('companyB', 'Apex Constructions')
  })

  it('validates its arguments: an explicit project, ONE company, exactly one of --enable / --disable — and there is no way to name every company', async () => {
    const usageCases = [
      [],
      ['--company', COMPANY_A, '--enable'],                 // no --project
      ['--project', PROJECT_ID, '--enable'],                // no --company
      base,                                                 // neither --enable nor --disable
      [...base, '--enable', '--disable'],
      [...base, '--enable', '--all'],
      ['--project', PROJECT_ID, '--all', '--enable'],
      ['--project', PROJECT_ID, '--company', 'bad id', '--enable'],
      ['--project', PROJECT_ID, '--company', 'a/b', '--enable'],
      ['--project', PROJECT_ID, '--company-id', COMPANY_A, '--enable'],
      [...base, '--enable', '--bogus'],
    ]
    for (const args of usageCases) {
      const r = run('set-client-finance.mjs', args)
      expect(r.code, args.join(' ')).toBe(2)
      expect(r.out, args.join(' ')).toContain('Usage: node scripts/set-client-finance.mjs')
    }
    expect(run('set-client-finance.mjs', [...base, '--enable', '--apply'], { GOOGLE_APPLICATION_CREDENTIALS: '/tmp/key.json' }).code).toBe(1)
    expect(await companyDoc()).toEqual(SEEDED)
    expect(await auditTypes(COMPANY_A)).toEqual([])
  })

  it('is DRY-RUN BY DEFAULT: it prints the current and the new value, ids only, and writes nothing', async () => {
    const dry = run('set-client-finance.mjs', [...base, '--enable'])
    expect(dry.code).toBe(0)
    expect(dry.out).toContain(`[DRY RUN — read only] Project ${PROJECT_ID} (EMULATORS) · company ${COMPANY_A}`)
    expect(dry.out).toContain('clientFinanceEnabled now:   not enabled (field absent)')
    expect(dry.out).toContain('clientFinanceEnabled after: ENABLED (true)')
    expect(dry.out).toContain('Dry run — nothing written. Re-run with --apply.')
    // Name-free: the company's name is never printed.
    expect(dry.out).not.toContain('Acme')
    expect(await companyDoc()).toEqual(SEEDED)
    expect(await auditTypes(COMPANY_A)).toEqual([])
  })

  it('--enable --apply writes ONLY clientFinanceEnabled (merged) and one audit event; a repeat changes nothing; the other company is untouched', async () => {
    const applied = run('set-client-finance.mjs', [...base, '--enable', '--apply'])
    expect(applied.code, applied.out).toBe(0)
    expect(applied.out).toContain('[APPLY]')
    expect(applied.out).toContain(`Applied, with one audit event (company.client_finance_set). Company ${COMPANY_A}: clientFinanceEnabled is now true.`)
    expect(applied.out).not.toContain('Acme')
    expect(await companyDoc()).toEqual({ ...SEEDED, clientFinanceEnabled: true })
    const written = await events()
    expect(written).toHaveLength(1)
    expect(written[0]).toMatchObject({
      type: 'company.client_finance_set', actorUid: 'operator', source: 'operator',
      before: { clientFinanceEnabled: null }, after: { clientFinanceEnabled: true },
    })
    // A second run, dry or applied: no change, no second event.
    for (const extra of [[], ['--apply']]) {
      const again = run('set-client-finance.mjs', [...base, '--enable', ...extra])
      expect(again.code).toBe(0)
      expect(again.out).toContain('clientFinanceEnabled now:   ENABLED (true)')
      expect(again.out).toContain('No change: the company already holds exactly that value. Nothing written.')
    }
    expect(await events()).toHaveLength(1)
    // "Apex" was never named and never touched.
    expect(await companyDoc('companyB')).toEqual({ name: 'Apex Constructions', countryCode: 'AU', baseCurrency: 'AUD' })
    expect(await auditTypes('companyB')).toEqual([])
  })

  it('--disable --apply records the explicit false with its own audit event and the honest warning; only a strict true counts as enabled', async () => {
    run('set-client-finance.mjs', [...base, '--enable', '--apply'])
    const off = run('set-client-finance.mjs', [...base, '--disable', '--apply'])
    expect(off.code, off.out).toBe(0)
    expect(off.out).toContain('clientFinanceEnabled is now false')
    expect(off.out).toContain('Nothing already posted was undone.')
    expect(await companyDoc()).toEqual({ ...SEEDED, clientFinanceEnabled: false })
    expect((await events()).map(e => [e.before.clientFinanceEnabled, e.after.clientFinanceEnabled]).sort()).toEqual([[null, true], [true, false]].sort())
    // A value that is not a boolean is reported as it is, and --enable replaces it with true.
    await A.db.collection('companies').doc(COMPANY_A).update({ clientFinanceEnabled: 'true' })
    const odd = run('set-client-finance.mjs', [...base, '--enable'])
    expect(odd.out).toContain('clientFinanceEnabled now:   not enabled ("true")')
    expect(run('set-client-finance.mjs', [...base, '--enable', '--apply']).code).toBe(0)
    expect((await companyDoc()).clientFinanceEnabled).toBe(true)
  })

  it('--receipts switches ONLY clientReceiptsEnabled, with its own audit event — independent of clientFinanceEnabled in both directions', async () => {
    const dry = run('set-client-finance.mjs', [...base, '--receipts', '--enable'])
    expect(dry.code).toBe(0)
    expect(dry.out).toContain('clientReceiptsEnabled now:   not enabled (field absent)')
    expect(dry.out).toContain('Dry run — nothing written. Re-run with --apply.')
    expect(await companyDoc()).toEqual(SEEDED)
    const applied = run('set-client-finance.mjs', [...base, '--receipts', '--enable', '--apply'])
    expect(applied.code, applied.out).toBe(0)
    expect(applied.out).toContain(`Applied, with one audit event (company.client_receipts_set). Company ${COMPANY_A}: clientReceiptsEnabled is now true.`)
    expect(applied.out).toContain('CLIENT_RECEIPT_POSTING_ENABLED must also be on')
    expect(applied.out).not.toContain('Acme')
    expect(await companyDoc()).toEqual({ ...SEEDED, clientReceiptsEnabled: true })
    expect(await events()).toEqual([expect.objectContaining({
      type: 'company.client_receipts_set', actorUid: 'operator', source: 'operator',
      before: { clientReceiptsEnabled: null }, after: { clientReceiptsEnabled: true },
    })])
    // The credit-note flag, set afterwards, leaves the receipt flag alone — and the reverse.
    expect(run('set-client-finance.mjs', [...base, '--enable', '--apply']).code).toBe(0)
    expect(await companyDoc()).toEqual({ ...SEEDED, clientReceiptsEnabled: true, clientFinanceEnabled: true })
    expect(run('set-client-finance.mjs', [...base, '--receipts', '--disable', '--apply']).code).toBe(0)
    expect(await companyDoc()).toEqual({ ...SEEDED, clientReceiptsEnabled: false, clientFinanceEnabled: true })
    expect((await events()).map(e => e.type).sort()).toEqual(['company.client_finance_set', 'company.client_receipts_set', 'company.client_receipts_set'])
    expect(await companyDoc('companyB')).toEqual({ name: 'Apex Constructions', countryCode: 'AU', baseCurrency: 'AUD' })
  })

  it('refuses an unknown company — exit 1, nothing created, with or without --apply', async () => {
    for (const extra of [[], ['--apply']]) {
      const r = run('set-client-finance.mjs', ['--project', PROJECT_ID, '--company', 'nope', '--enable', ...extra])
      expect(r.code).toBe(1)
      expect(r.out).toContain(`Refused: company nope does not exist in project ${PROJECT_ID}. Nothing written.`)
    }
    expect((await A.db.collection('companies').get()).docs.map(d => d.id).sort()).toEqual([COMPANY_A, 'companyB'].sort())
    expect((await A.db.collection('companies').doc('nope').collection('auditEvents').get()).empty).toBe(true)
  })

  it('a failure inside its transaction: reported once, exit 1, nothing written, not retried — and the company document is free at once', async () => {
    const r = run('set-client-finance.mjs', [...base, '--enable', '--apply'], { NODE_OPTIONS: `--import=${REFUSE_TRANSACTION}` })
    expect(r.code).toBe(1)
    expect(r.out).toContain('simulated refusal inside the transaction')
    expect((r.stderr.match(/\[fixture\] transaction 1 attempt/g) ?? []).length).toBe(1)
    expect(r.stderr).not.toContain('did not shut down')
    expect(await companyDoc()).toEqual(SEEDED)
    expect(await auditTypes(COMPANY_A)).toEqual([])
    expect(await writableAtOnce(A.db.collection('companies').doc(COMPANY_A))).toBe(true)
  })

  it('what it switches is what the callables read: enabled → the four act; disabled → client-finance-not-activated', async () => {
    const { createClientFinanceHandlers } = await import('../../functions/src/clientFinance/handlers.js')
    const H = createClientFinanceHandlers({ db: A.db, now: () => new Date(), log: { info() {}, warn() {}, error() {} }, config: () => ({ finance: true, receipts: true, receiptsAllCompanies: true }) })
    await seedUser({ uid: 'u_admin', email: 'admin@acme.test', role: 'company_admin', companyId: COMPANY_A })
    await seedProjects(COMPANY_A, ['p1'])
    // The pause lets the refused transaction's rollback leave this process before
    // spawnSync blocks its event loop — otherwise the company document it read stays locked.
    const call = async () => {
      const code = await H.voidClientCreditNote(req('u_admin', { projectId: 'p1', creditNoteId: 'nope', reason: 'x' })).then(() => 'ok', e => e.details?.code)
      await new Promise(r => setTimeout(r, 500))
      return code
    }
    expect(await call()).toBe('client-finance-not-activated')
    expect(run('set-client-finance.mjs', [...base, '--enable', '--apply']).code).toBe(0)
    expect(await call()).toBe('client-entry-not-found')   // past the gate: the entry simply does not exist
    expect(run('set-client-finance.mjs', [...base, '--disable', '--apply']).code).toBe(0)
    expect(await call()).toBe('client-finance-not-activated')
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

// ── Operator tooling safety (D3 #3): no premature exit after a refusal ──────
//
// Each of the four older scripts used to call process.exit() after a failed
// transaction, before the SDK's un-awaited rollback went out; the documents
// that transaction read stayed locked for about a minute. They now return an
// exit code and terminate the Firestore client, which waits for that rollback.
describe('operator script lifecycle after a refused transaction', () => {
  const refusing = { NODE_OPTIONS: `--import=${REFUSE_TRANSACTION}` }
  const attempts = (r) => (r.stderr.match(/\[fixture\] transaction 1 attempt/g) ?? []).length

  it('backfill-project-directory.mjs: reports the failure once, exits 1, writes no entry and leaves the project unlocked', async () => {
    await seedCompany(COMPANY_A)
    await seedProjects(COMPANY_A, ['p1'], { directory: false })
    const r = run('backfill-project-directory.mjs', ['--project', PROJECT_ID, '--apply'], refusing)
    expect(r.code).toBe(1)
    expect(r.out).toContain(`FAILED    companies/${COMPANY_A}/projects/p1 — simulated refusal inside the transaction`)
    expect(attempts(r)).toBe(1)
    expect((await A.db.collection('companies').doc(COMPANY_A).collection('projectDirectory').get()).size).toBe(0)
    expect(await writableAtOnce(A.db.collection('companies').doc(COMPANY_A).collection('projectDirectory').doc('p1'))).toBe(true)
    expect(await writableAtOnce(project(COMPANY_A, 'p1'))).toBe(true)
  })

  it('reconcile-membership.mjs --fix: a refused F2 fix exits 1, keeps the field, writes no audit event and leaves the profile unlocked', async () => {
    await seedCompany(COMPANY_A)
    await seedUser({ uid: 'u_admin', email: 'admin@acme.test', role: 'company_admin', companyId: COMPANY_A })
    await seedUser({ uid: 'u_qs', email: 'qs@acme.test', role: 'qs', companyId: COMPANY_A })
    await A.db.collection('users').doc('u_qs').update({ projectIds: ['p1'] })   // R7
    const r = run('reconcile-membership.mjs', ['--project', PROJECT_ID, '--fix'], refusing)
    expect(r.code).toBe(1)
    expect(r.out).toContain('simulated refusal inside the transaction')
    expect(attempts(r)).toBe(1)
    expect((await A.db.collection('users').doc('u_qs').get()).data().projectIds).toEqual(['p1'])
    expect(await auditTypes(COMPANY_A)).toEqual([])
    expect(await writableAtOnce(A.db.collection('users').doc('u_qs'))).toBe(true)
  })

  it('exit codes are kept and the processes end promptly on success, refusal and usage error', async () => {
    await seedCompany(COMPANY_A)
    const timed = (script, args, env) => { const t = Date.now(); const r = run(script, args, env); return { ...r, ms: Date.now() - t } }
    const cases = [
      ['revoke-file-links.mjs', ['--project', PROJECT_ID, '--bucket', 'some-bucket.firebasestorage.app', '--company-id', 'nope'], 1],
      ['revoke-file-links.mjs', ['--project', PROJECT_ID, '--bucket', 'some-bucket.firebasestorage.app'], 2],
      ['backfill-project-directory.mjs', ['--project', PROJECT_ID], 0],
      ['backfill-project-directory.mjs', ['--project', PROJECT_ID, '--company-id', 'nope'], 1],
      ['reconcile-membership.mjs', ['--project', PROJECT_ID, '--company-id', COMPANY_A], 0],
      ['reconcile-membership.mjs', ['--project', PROJECT_ID, '--company-id', 'nope'], 1],
      ['reconcile-membership.mjs', ['--project', PROJECT_ID, '--bogus'], 2],
      ['bootstrap-company.mjs', ['--project', PROJECT_ID, '--company-id', 'acme', '--company-name', 'Acme', '--admin-email', 'a@acme.test'], 0],
    ]
    for (const [script, args, code] of cases) {
      const r = timed(script, args)
      expect(r.code, `${script} ${args.join(' ')}\n${r.out}`).toBe(code)
      expect(r.ms, script).toBeLessThan(15000)
      expect(r.stderr, script).not.toContain('did not shut down')
    }
    // reconcile's JSON mode still carries exactly one stdout line on a refusal-free run.
    const json = run('reconcile-membership.mjs', ['--project', PROJECT_ID, '--company-id', COMPANY_A], { RECONCILE_JSON: '1' })
    expect(json.code).toBe(0)
    expect(json.stdout.trim().split('\n')).toHaveLength(1)
  })
})
