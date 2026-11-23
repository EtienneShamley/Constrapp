#!/usr/bin/env node
// ── Operator: provision a client or subcontractor (M2-A2 Stage B, ADR-84) ────
//
//   node scripts/provision-external-member.mjs --project <firebase-project-id> \
//     --company-id <id> --email <address> --role client|subcontractor \
//     --project-ids <id>[,<id>…] \
//     [--apply (--no-link | --link-file <path> [--app-url <origin>])]
//
// DRY RUN BY DEFAULT. Without --apply it only READS: it checks the company,
// the email, the role and every project, and prints what it would do.
//
// With --apply it creates ONE pending invitation for the external role,
// carrying the 1–30 projects that member will read. Nothing else is created:
// no Auth account, no password, no membership. The person becomes a member
// only by accepting the invitation in the application, signed in with the
// invited email — and acceptance checks the role and every project again.
//
// ⚠️ THE ACCEPTANCE LINK IS A CREDENTIAL AND IS NEVER PRINTED. Choose one:
//
//   --no-link            the link is discarded. A Company Admin then sends it
//                        from Settings → Team → Resend, which emails a fresh
//                        link to the invited address. Nothing secret touches
//                        this machine. PREFERRED.
//   --link-file <path>   the link is written to a NEW file, mode 0600, outside
//                        this repository. Hand it over on a channel you trust
//                        and delete the file. A link delivered this way proves
//                        nothing about the mailbox.
//
// It never creates a company, never changes an existing member, and refuses an
// email that already holds a pending invitation (revoke that one in the Team
// page first) or an active membership anywhere.
//
// Exit code: 0 done (or dry run clean), 1 refused, 2 usage error.

import { closeSync, existsSync, openSync, statSync, unlinkSync, writeSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs, usage, configureProject, log, silentLogger, ID_LIST_PATTERN, parseIdList, describeRefusal } from './_cli.mjs'

const NAME = 'scripts/provision-external-member.mjs'
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

const SPEC = {
  'project':     { required: true, pattern: /^[a-z0-9-]{4,40}$/, help: 'Firebase project id (explicit, always)' },
  'company-id':  { required: true, pattern: /^[A-Za-z0-9_-]{1,64}$/, help: 'the company the member joins' },
  'email':       { required: true, pattern: /^[^\s@]+@[^\s@]+\.[^\s@]+$/, help: 'the invited email address' },
  'role':        { required: true, pattern: /^(client|subcontractor)$/, help: 'client or subcontractor — nothing else' },
  'project-ids': { required: true, pattern: ID_LIST_PATTERN, help: '1–30 project ids of that company, comma-separated' },
  'apply':       { flag: true, help: 'create the invitation; without it nothing is written' },
  'no-link':     { flag: true, help: 'with --apply: discard the link; a Company Admin sends it with Resend' },
  'link-file':   { pattern: /^.{1,1024}$/, help: 'with --apply: write the link to this NEW file (mode 0600)' },
  'app-url':     { pattern: /^https?:\/\/[^\s/]+$/, help: 'origin for the link file (defaults to APP_BASE_URL env)' },
}

function fatalUsage(message) {
  log.error(message)
  console.log(usage(NAME, SPEC))
  process.exit(2)
}

async function main() {
  let args
  try { args = parseArgs(process.argv.slice(2), SPEC) } catch (e) { fatalUsage(e.message) }
  const apply = !!args.apply
  const linkFile = args['link-file'] ? resolve(args['link-file']) : null
  if (apply && !!args['no-link'] === !!linkFile) fatalUsage('--apply needs exactly one of --no-link or --link-file <path>')
  if (!apply && (args['no-link'] || linkFile || args['app-url'])) fatalUsage('--no-link, --link-file and --app-url are only meaningful with --apply')

  const { emulated } = configureProject(args.project)
  const appBaseUrl = linkFile ? (args['app-url'] ?? process.env.APP_BASE_URL ?? '') : ''
  if (linkFile) {
    if (!appBaseUrl) fatalUsage('--link-file needs --app-url (or APP_BASE_URL) to build the acceptance link')
    if (!emulated && !appBaseUrl.startsWith('https://')) fatalUsage('--app-url must be an https origin outside the emulators')
    if (linkFile === REPO_ROOT || linkFile.startsWith(REPO_ROOT + sep)) fatalUsage('--link-file must be OUTSIDE this repository: an acceptance link must never be committed')
    if (existsSync(linkFile)) fatalUsage('--link-file names a file that already exists; nothing is overwritten')
    if (!existsSync(dirname(linkFile)) || !statSync(dirname(linkFile)).isDirectory()) fatalUsage('--link-file: the folder does not exist')
  }

  const { getDb, getAdminAuth } = await import('../src/lib/firebaseAdmin.js')
  const { provisionExternalMember, projectsWithoutDirectoryEntry } = await import('../src/lib/memberProjects.js')

  const db = getDb()
  const deps = {
    db, auth: getAdminAuth(), now: () => new Date(), log: silentLogger,
    email: { kind: 'none', async send() { throw new Error('this script never emails') } },
    config: () => ({ appBaseUrl, emailFrom: '', enabled: true, inviteTtlMs: 7 * 24 * 60 * 60 * 1000 }),
  }
  const request = { companyId: args['company-id'], email: args.email, role: args.role, projectIds: parseIdList(args['project-ids']) }

  log.info(`${apply ? '[APPLY] ' : '[DRY RUN — read only] '}Project ${args.project}${emulated ? ' (EMULATORS)' : ''} · company ${request.companyId}`)

  // Every check, with no write — also before an --apply, so a refusal never
  // leaves a link file behind.
  const plan = await provisionExternalMember(deps, { ...request, dryRun: true })
  log.info(`• company "${plan.companyName}" exists`)
  log.info(`• ${plan.email} — ${plan.account === 'new' ? 'no account yet: they register when they accept' : plan.account === 'disabled' ? 'a DISABLED account with no active membership: opening the invitation re-enables it' : 'an existing account with no active membership: they sign in, then accept'}`)
  log.info(`• role ${plan.role}`)
  log.info(`• ${plan.projectIds.length} project(s), all found in this company: ${plan.projectIds.join(', ')}`)
  const gaps = await projectsWithoutDirectoryEntry(db, plan.companyId, plan.projectIds)
  if (gaps.length > 0) log.warn(`no project-directory entry for: ${gaps.join(', ')} — assigned and readable, but absent from the member's project list until the project is saved in the app or the directory backfill is run`)

  if (!apply) {
    log.info('')
    log.info('Dry run — nothing written. Re-run with --apply and either --no-link or --link-file <path>.')
    return
  }

  // Reserve the link file BEFORE the invitation exists, so the link is never
  // created without somewhere private to put it.
  let fd = null
  if (linkFile) fd = openSync(linkFile, 'wx', 0o600)
  let done
  try {
    done = await provisionExternalMember(deps, { ...request, dryRun: false })
    if (fd !== null) writeSync(fd, `${done.link}\n`)
  } catch (e) {
    if (fd !== null) { closeSync(fd); fd = null; try { unlinkSync(linkFile) } catch { /* nothing to remove */ } }
    throw e
  } finally {
    if (fd !== null) closeSync(fd)
  }

  log.info(`• invitation ${done.inviteId} created (expires ${done.expiresAt}) — pending until accepted`)
  log.info('')
  if (linkFile) {
    log.info(`The acceptance link is in ${linkFile} (mode 0600). It is NOT shown here.`)
    log.info('Hand it to the invitee on a channel you trust, then delete the file.')
  } else {
    log.info('No link was kept. A Company Admin now opens Settings → Team → Pending invitations')
    log.info(`and presses Resend for ${done.email}: that emails a fresh link to the invited address.`)
  }
  log.info('The member has NO access until they accept. Acceptance checks the role and every project again.')
}

// `process.exitCode`, not `process.exit()`: the Firestore SDK sends a failed
// transaction's rollback WITHOUT waiting for it. Exiting at once would drop
// that request and leave the company membership lock held until Firestore
// times the transaction out.
main().catch((e) => {
  const refusal = describeRefusal(e)
  log.error(refusal ? `Refused: ${refusal}` : (e?.message ?? e))
  process.exitCode = 1
})
