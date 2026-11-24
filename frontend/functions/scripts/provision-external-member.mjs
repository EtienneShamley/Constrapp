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
//                        nothing about the mailbox. The destination is checked
//                        and created by _linkFile.mjs, exactly as for the
//                        bootstrap: the folder's REAL path must lie outside the
//                        repository (a symbolic link into it is refused), the
//                        file must not exist (a symbolic link counts), and it
//                        is created exclusively, mode 0600, before any write.
//
// If the invitation commits but the link file cannot be written, the script
// exits 3, names the invitation and removes the partial file; the link is not
// shown and nothing is retried. Recover WITHOUT a second invitation: a Company
// Admin presses Resend for the email (a fresh link, emailed; the lost one stops
// working), or revokes the invitation in the Team page and this script is run
// again. A plain re-run is refused (invite-pending) — it never rotates.
//
// It never creates a company, never changes an existing member, and refuses an
// email that already holds a pending invitation (revoke that one in the Team
// page first) or an active membership anywhere.
//
// Exit code: 0 done (or dry run clean), 1 refused, 2 usage error,
// 3 invitation committed but the link file was not written.

import { parseArgs, usage, configureProject, log, silentLogger, ID_LIST_PATTERN, parseIdList, describeRefusal } from './_cli.mjs'
import { checkLinkFileDestination, reserveLinkFile, deliverToLinkFile, discardLinkFile, redactCredentials, LinkFileError } from './_linkFile.mjs'

const NAME = 'scripts/provision-external-member.mjs'

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
  const wantsFile = args['link-file'] !== undefined
  if (apply && !!args['no-link'] === wantsFile) fatalUsage('--apply needs exactly one of --no-link or --link-file <path>')
  if (!apply && (args['no-link'] || wantsFile || args['app-url'])) fatalUsage('--no-link, --link-file and --app-url are only meaningful with --apply')

  const { emulated } = configureProject(args.project)
  const appBaseUrl = wantsFile ? (args['app-url'] ?? process.env.APP_BASE_URL ?? '') : ''
  let linkFile = null
  if (wantsFile) {
    if (!appBaseUrl) fatalUsage('--link-file needs --app-url (or APP_BASE_URL) to build the acceptance link')
    if (!emulated && !appBaseUrl.startsWith('https://')) fatalUsage('--app-url must be an https origin outside the emulators')
    try { linkFile = checkLinkFileDestination(args['link-file']) } catch (e) { fatalUsage(e.message) }
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
  // created without somewhere private to put it, and a destination that
  // changed since the check writes nothing.
  let reserved = null
  if (linkFile) {
    try { reserved = reserveLinkFile(linkFile) } catch (e) {
      if (!(e instanceof LinkFileError)) throw e
      log.error(e.message)
      process.exitCode = 1
      return
    }
  }
  let done
  try {
    done = await provisionExternalMember(deps, { ...request, dryRun: false })
  } catch (e) {
    if (reserved) discardLinkFile(reserved)   // refused: no link exists for this file
    throw e
  }

  log.info(`• invitation ${done.inviteId} created (expires ${done.expiresAt}) — pending until accepted`)
  log.info('')
  if (reserved) {
    const delivered = deliverToLinkFile(reserved, done.link)
    if (!delivered.ok) {
      log.error(`The invitation ${done.inviteId} IS CREATED, but the link could not be written to ${linkFile} (${delivered.code}).`)
      log.error(`The link is lost and was not shown${delivered.removed ? '; the partial file was removed' : ''}. Nothing was retried.`)
      log.error(`Recover without a second invitation: a Company Admin presses Resend for ${done.email} in Settings → Team (a fresh link, emailed),`)
      log.error('or revokes that invitation there and runs this script again. A plain re-run is refused (invite-pending).')
      process.exitCode = 3
      return
    }
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
  log.error(redactCredentials(refusal ? `Refused: ${refusal}` : (e?.message ?? e)))
  process.exitCode = 1
})
