import { afterEach, beforeEach, describe, it, expect } from 'vitest'
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { checkLinkFileDestination, reserveLinkFile, deliverToLinkFile, discardLinkFile, redactCredentials, LinkFileError, REPO_ROOT } from '../scripts/_linkFile.mjs'

// ── Operator tooling safety (D3 #1–#3) — no emulator, no network ────────────

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const read = (f) => readFileSync(join(ROOT, f), 'utf8')
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1')
const LINK = 'https://app.example/accept-invite#c=acme&i=INV123&t=' + 'A'.repeat(43)

let dir
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'constrap-linkfile-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const refusal = (fn) => { try { fn() } catch (e) { expect(e).toBeInstanceOf(LinkFileError); return e.message } throw new Error('expected a refusal') }

describe('link file: destination checks (nothing is created)', () => {
  it('accepts a new file in a private folder outside the repository', () => {
    expect(checkLinkFileDestination(join(dir, 'l.txt'))).toBe(join(dir, 'l.txt'))
    expect(readdirSync(dir)).toEqual([])
  })

  it('refuses the repository, directly or through a symbolic link to a folder inside it', () => {
    expect(refusal(() => checkLinkFileDestination(join(REPO_ROOT, 'l.txt')))).toContain('OUTSIDE this repository')
    expect(refusal(() => checkLinkFileDestination(join(ROOT, 'scripts', 'l.txt')))).toContain('OUTSIDE this repository')
    symlinkSync(ROOT, join(dir, 'alias'))
    expect(refusal(() => checkLinkFileDestination(join(dir, 'alias', 'l.txt')))).toContain('OUTSIDE this repository')
    expect(existsSync(join(ROOT, 'l.txt'))).toBe(false)
  })

  it('refuses an existing file, a symbolic link to a file, and a dangling symbolic link', () => {
    writeFileSync(join(dir, 'f.txt'), 'keep')
    symlinkSync(join(dir, 'f.txt'), join(dir, 'link.txt'))
    symlinkSync(join(dir, 'absent.txt'), join(dir, 'dangling.txt'))
    for (const f of ['f.txt', 'link.txt', 'dangling.txt']) expect(refusal(() => checkLinkFileDestination(join(dir, f)))).toContain('already exists')
    expect(readFileSync(join(dir, 'f.txt'), 'utf8')).toBe('keep')
    expect(existsSync(join(dir, 'absent.txt'))).toBe(false)
  })

  it('refuses a missing folder, a file used as a folder, a folder others can write to, and a folder of another user', () => {
    expect(refusal(() => checkLinkFileDestination(join(dir, 'nope', 'l.txt')))).toContain('does not exist')
    writeFileSync(join(dir, 'plain'), '')
    expect(refusal(() => checkLinkFileDestination(join(dir, 'plain', 'l.txt')))).toMatch(/does not exist|not a directory/)
    mkdirSync(join(dir, 'open')); chmodSync(join(dir, 'open'), 0o777)
    expect(refusal(() => checkLinkFileDestination(join(dir, 'open', 'l.txt')))).toContain('writable by other users')
    mkdirSync(join(dir, 'group')); chmodSync(join(dir, 'group'), 0o770)
    expect(refusal(() => checkLinkFileDestination(join(dir, 'group', 'l.txt')))).toContain('writable by other users')
    mkdirSync(join(dir, 'sticky')); chmodSync(join(dir, 'sticky'), 0o1777)          // like /tmp
    expect(checkLinkFileDestination(join(dir, 'sticky', 'l.txt'))).toBe(join(dir, 'sticky', 'l.txt'))
    expect(refusal(() => checkLinkFileDestination(join(dir, 'l.txt'), { uid: process.getuid() + 1 }))).toContain('another user')
  })
})

describe('link file: reservation, delivery and removal', () => {
  it('reserves an empty regular file, mode 0600, one link, owned by the operator', () => {
    const r = reserveLinkFile(join(dir, 'l.txt'))
    const st = statSync(r.path)
    expect(st.isFile()).toBe(true)
    expect(st.mode & 0o777).toBe(0o600)
    expect(st.nlink).toBe(1)
    expect(st.uid).toBe(process.getuid())
    expect(st.size).toBe(0)
    expect(deliverToLinkFile(r, LINK)).toEqual({ ok: true })
    expect(readFileSync(r.path, 'utf8')).toBe(`${LINK}\n`)
    expect(statSync(r.path).mode & 0o777).toBe(0o600)
  })

  it('is exclusive: a second reservation of the same path is refused and the first file is untouched', () => {
    const first = reserveLinkFile(join(dir, 'l.txt'))
    expect(refusal(() => reserveLinkFile(join(dir, 'l.txt')))).toContain('already exists')
    expect(deliverToLinkFile(first, LINK).ok).toBe(true)
    expect(readFileSync(first.path, 'utf8')).toBe(`${LINK}\n`)
  })

  it('concurrent processes: exactly one of eight creates the file', async () => {
    const target = join(dir, 'race.txt')
    const code = `import { reserveLinkFile, deliverToLinkFile } from ${JSON.stringify(pathToFileURL(join(ROOT, 'scripts/_linkFile.mjs')).href)}
      try { const r = reserveLinkFile(${JSON.stringify(target)}); deliverToLinkFile(r, 'winner-' + process.pid); process.stdout.write('won') } catch (e) { process.stdout.write('lost:' + e.message) }`
    const one = () => new Promise((res) => {
      const ch = spawn(process.execPath, ['--input-type=module', '-e', code])
      let out = ''
      ch.stdout.on('data', (d) => { out += d })
      ch.on('exit', () => res(out))
    })
    const outs = await Promise.all(Array.from({ length: 8 }, one))
    expect(outs.filter(o => o === 'won')).toHaveLength(1)
    for (const o of outs.filter(o => o !== 'won')) expect(o).toMatch(/^lost:--link-file: (names a file or link that already exists|appeared while being created)/)
    expect(readFileSync(target, 'utf8')).toMatch(/^winner-\d+\n$/)
  })

  it('a failed write removes the partial file and never returns the link', () => {
    const r = reserveLinkFile(join(dir, 'l.txt'))
    const result = deliverToLinkFile(r, LINK, (fd) => { writeFileSync(fd, LINK.slice(0, 10)); throw Object.assign(new Error(`ENOSPC writing ${LINK}`), { code: 'ENOSPC' }) })
    expect(result).toEqual({ ok: false, code: 'ENOSPC', removed: true })
    expect(JSON.stringify(result)).not.toContain('accept-invite')
    expect(existsSync(r.path)).toBe(false)
  })

  it('discard removes the reserved file — and never a different file that replaced it', () => {
    const a = reserveLinkFile(join(dir, 'a.txt'))
    expect(discardLinkFile(a)).toBe(true)
    expect(existsSync(a.path)).toBe(false)
    const b = reserveLinkFile(join(dir, 'b.txt'))
    unlinkSync(b.path)
    writeFileSync(b.path, 'someone else')
    expect(discardLinkFile(b)).toBe(false)
    expect(readFileSync(b.path, 'utf8')).toBe('someone else')
  })

  it('a reservation through a folder link into the repository is refused and leaves nothing there', () => {
    symlinkSync(ROOT, join(dir, 'alias'))
    expect(refusal(() => reserveLinkFile(join(dir, 'alias', 'leak.txt')))).toContain('OUTSIDE this repository')
    expect(existsSync(join(ROOT, 'leak.txt'))).toBe(false)
    expect(lstatSync(join(dir, 'alias')).isSymbolicLink()).toBe(true)
  })

  it('redacts anything shaped like an acceptance link or its token', () => {
    expect(redactCredentials(`failed: ${LINK} end`)).toBe('failed: [redacted link] end')
    expect(redactCredentials('x?c=a&t=abcDEF_-123 y')).toBe('x?c=a&t=[redacted] y')
    expect(redactCredentials('invitation INV123 refused')).toBe('invitation INV123 refused')
  })
})

// ── runOperatorScript: exit codes and SDK shutdown, in real child processes ──

const CLI = pathToFileURL(join(ROOT, 'scripts/_cli.mjs')).href
function child(body, timeout = 20000) {
  const src = `import { runOperatorScript, releaseOnExit, UsageError } from ${JSON.stringify(CLI)}\n${body}`
  const t = Date.now()
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', src], { encoding: 'utf8', timeout })
  return { code: r.status, signal: r.signal, stdout: r.stdout, stderr: r.stderr, ms: Date.now() - t }
}

describe('runOperatorScript', () => {
  it('keeps the exit code main returns: 0 when it returns nothing, any explicit code otherwise', () => {
    expect(child('runOperatorScript(async () => {})').code).toBe(0)
    expect(child('runOperatorScript(async () => 3)').code).toBe(3)
    expect(child('runOperatorScript(async () => 1)').code).toBe(1)
  })

  it('reports an error once and exits 1; a UsageError exits 2 with the usage text', () => {
    const err = child("runOperatorScript(async () => { throw new Error('boom') })")
    expect(err.code).toBe(1)
    expect(err.stderr).toContain('✖ boom')
    const use = child("runOperatorScript(async () => { throw new UsageError('--x is required') }, { usageText: 'Usage: test' })")
    expect(use.code).toBe(2)
    expect(use.stderr).toContain('✖ --x is required')
    expect(use.stdout).toContain('Usage: test')
  })

  it('awaits every shutdown step AFTER main settles — also after an error — and keeps the code', () => {
    const r = child(`releaseOnExit(async () => { await new Promise(r => setTimeout(r, 300)); console.log('released') })
      runOperatorScript(async () => { console.log('main'); throw new Error('refused') })`)
    expect(r.code).toBe(1)
    expect(r.stdout).toBe('main\nreleased\n')
  })

  it('a failing shutdown step is reported as an explicit FAILURE, never as a clean shutdown, and keeps the code', () => {
    for (const code of [0, 1, 3]) {
      const r = child(`releaseOnExit(async () => { throw new Error('channel closed') })
        runOperatorScript(async () => ${code})`)
      expect(r.code).toBe(code)
      expect(r.stderr).toContain('✖ Cleanup FAILED: the SDK did not shut down cleanly (channel closed).')
      expect(r.stderr).toContain(`✖ Cleanup is INCOMPLETE. The result above stands (exit ${code}); nothing was retried.`)
      expect(r.stdout + r.stderr).not.toMatch(/cleanup (complete|succeeded|ok)\b|shut down cleanly\.$/im)
    }
  })

  it('never hangs: a shutdown that does not finish is a reported failure after the timeout — forced exit, code kept', () => {
    for (const code of [0, 1]) {
      const r = child(`setInterval(() => {}, 1000)
        releaseOnExit(() => new Promise(() => {}))
        runOperatorScript(async () => ${code}, { releaseTimeoutMs: 500 })`)
      expect(r.signal).toBeNull()
      expect(r.code).toBe(code)
      expect(r.stderr).toContain(`✖ Cleanup did NOT complete within 1 s — the process is being terminated. The result above stands (exit ${code}); nothing was retried.`)
      expect(r.stderr).toContain('may not have reached Firestore')
      expect(r.ms).toBeLessThan(10000)
    }
  })

  it('the timeout clock starts only after main has settled: a long operation is never cut short', () => {
    const r = child(`let calls = 0
      releaseOnExit(async () => { await new Promise(r => setTimeout(r, 100)); console.log('released') })
      runOperatorScript(async () => { calls += 1; await new Promise(r => setTimeout(r, 1500)); console.log('main done', calls); return 0 }, { releaseTimeoutMs: 500 })`)
    expect(r.code).toBe(0)
    expect(r.stdout).toBe('main done 1\nreleased\n')
    expect(r.stderr).toBe('')
  })

  it('a clean shutdown prints nothing about cleanup, and main runs exactly once — even when it throws', () => {
    const ok = child(`releaseOnExit(async () => {})
      runOperatorScript(async () => 0)`)
    expect(ok.code).toBe(0)
    expect(ok.stdout + ok.stderr).toBe('')
    const once = child(`let calls = 0
      releaseOnExit(async () => { console.log('calls', calls) })
      runOperatorScript(async () => { calls += 1; throw new Error('refused') })`)
    expect(once.code).toBe(1)
    expect(once.stdout).toBe('calls 1\n')
  })
})

// ── Source pins ──────────────────────────────────────────────────────────────

describe('operator scripts — tooling-safety source pins', () => {
  const OLDER = ['bootstrap-company.mjs', 'backfill-project-directory.mjs', 'reconcile-membership.mjs', 'revoke-file-links.mjs']

  it('the four older scripts never call process.exit(), run through runOperatorScript and terminate Firestore', () => {
    for (const f of OLDER) {
      const code = stripComments(read(`scripts/${f}`))
      expect(code, f).not.toMatch(/process\.exit\(/)
      expect(code, f).toMatch(/^runOperatorScript\(main, \{/m)
      expect(code, f).toContain('releaseOnExit(() => db.terminate())')
      expect(code, f).not.toMatch(/main\(\)\.catch/)
    }
    // The only process.exit left in the shared runner is the shutdown-timeout fallback.
    const cli = stripComments(read('scripts/_cli.mjs'))
    expect(cli.match(/process\.exit\(/g)).toHaveLength(1)
    expect(cli).toContain("if (cleanup === 'timed-out') process.exit(code)")
    expect(cli.indexOf('process.exitCode = code')).toBeLessThan(cli.indexOf('process.exit(code)'))
    // The shutdown clock is created inside releaseAll, which runs only after main() settled.
    const runner = cli.slice(cli.indexOf('export async function runOperatorScript'))
    expect(runner.indexOf('await main()')).toBeLessThan(runner.indexOf('await releaseAll('))
    expect(cli.slice(0, cli.indexOf('async function releaseAll')).match(/setTimeout/g)).toBeNull()
    // Nothing in the runner retries.
    expect(cli).not.toMatch(/retry|attempt/i)
  })

  it('bootstrap is dry-run by default and writes nothing before the read-only plan and the link-file reservation', () => {
    const code = stripComments(read('scripts/bootstrap-company.mjs'))
    expect(code).toMatch(/const apply = !!args\.apply/)
    const planAt = code.indexOf('const p = await plan(')
    const dryReturn = code.indexOf('if (!apply) {')
    const reserveAt = code.indexOf('reserved = reserveLinkFile(linkFile)')
    const firstWrite = Math.min(...['tx.create(companyRef', 'createInvitation(deps', 'withCompanyLock(db'].map(s => code.indexOf(s)))
    expect(planAt).toBeGreaterThan(0)
    expect(planAt).toBeLessThan(dryReturn)
    expect(dryReturn).toBeLessThan(reserveAt)
    expect(reserveAt).toBeLessThan(firstWrite)
    // The plan function itself only reads.
    const planFn = code.slice(code.indexOf('async function plan('), code.indexOf('async function main('))
    expect(planFn).not.toMatch(/\.(set|update|create|delete|add)\(|runTransaction|withCompanyLock/)
  })

  it('bootstrap: the acceptance link reaches the reserved file and nothing else — never the console', () => {
    const code = stripComments(read('scripts/bootstrap-company.mjs'))
    const linkUses = code.split('\n').filter(l => /\.link\b/.test(l)).map(l => l.trim())
    expect(linkUses).toEqual(['const delivered = deliverToLinkFile(reserved, result.link)'])
    expect(code).not.toMatch(/console\.(log|error|warn)/)
    expect(code).not.toMatch(/log\.(info|warn|error)\([^\n]*(\.link\b|token\b)/)
    expect(code).not.toMatch(/ACCEPTANCE LINK/)
    expect(code).not.toMatch(/password|createUser|generatePasswordResetLink|generateSignInWithEmailLink|createCustomToken/i)
    // Still the operator's own credentials, an explicit project, operator delivery.
    expect(code).toMatch(/'project':\s+\{ required: true/)
    expect(code).toContain('configureProject(args.project)')
    expect(code).not.toMatch(/serviceAccount|cert\(|\.json'/)
    expect(code).toContain("deliveredVia: DELIVERY.OPERATOR, source: 'operator'")
    expect(code).toContain("bootstrap never emails")
  })

  it('a pending invitation is rotated only on --rotate, re-checked under the membership lock', () => {
    const code = stripComments(read('scripts/bootstrap-company.mjs'))
    expect(code).toContain("if (existing && !rotate) return { refused:")
    const rotation = code.slice(code.indexOf('await withCompanyLock(db, companyId'), code.indexOf("const what = "))
    expect(rotation).toMatch(/d\.status !== 'pending' \|\| d\.email !== email \|\| d\.role !== 'company_admin'/)
    expect(rotation.indexOf("d.status !== 'pending'")).toBeLessThan(rotation.indexOf('tx.update(ref'))
  })

  it('the link-file module puts no link into a message', () => {
    const code = stripComments(read('scripts/_linkFile.mjs'))
    // Every message is fixed text; the only value ever interpolated is an errno code.
    const interpolated = [...code.matchAll(/new LinkFileError\(([^\n]*)\)/g)].flatMap(m => [...m[1].matchAll(/\$\{([^}]*)\}/g)].map(x => x[1].trim()))
    expect(interpolated.length).toBeGreaterThan(0)
    expect(new Set(interpolated)).toEqual(new Set(["e?.code ?? 'error'"]))
    expect(code).not.toMatch(/new LinkFileError\([^\n]*(\+|message)/)
    expect(code).not.toMatch(/console\./)
    expect(code).toContain('constants.O_EXCL')
    expect(code).toContain('constants.O_NOFOLLOW')
  })

  it('the deployed entry point reaches no operator script', () => {
    const files = ['src/index.js', ...readdirSync(join(ROOT, 'src/team')).map(f => `src/team/${f}`)]
    for (const f of files) expect(stripComments(read(f)), f).not.toMatch(/scripts\/|_cli\.mjs|_linkFile\.mjs/)
    expect(resolve(ROOT, '..', '..')).toBe(REPO_ROOT)
  })
})
