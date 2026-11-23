#!/usr/bin/env node
// ── Operator: change an external member's projects (M2-A2 Stage B, ADR-84) ───
//
//   node scripts/set-member-projects.mjs --project <firebase-project-id> \
//     --company-id <id> (--uid <uid> | --email <address>) \
//     (--set <id>[,<id>…] | --clear | [--add <ids>] [--remove <ids>]) [--apply]
//
// DRY RUN BY DEFAULT. Without --apply it only READS and prints the change.
//
// The member must be an ACTIVE client or subcontractor of that company. An
// internal member (Company Admin, Project Manager, QS) is refused: internal
// roles read every project and never hold an assignment.
//
//   --set      the complete new list (1–30 ids)
//   --clear    remove every project — the member stays active and reads none
//   --add / --remove   change the current list; safe to repeat, and two
//              operators adding at once both land
//
// Every project of the resulting list must exist in that company. The change,
// its audit event (`member.projects_changed`, the full list before and after)
// and — when a project is REMOVED — a file-link revocation request commit
// together, or not at all.
//
// ⚠️ A removal applies to the Rules at once. A download URL the member copied
// EARLIER can keep working until the background sweep finishes; the Team page
// shows "Old file links: revocation pending" for the member until then.
//
// Exit code: 0 done (or dry run clean), 1 refused, 2 usage error.

import { parseArgs, usage, configureProject, log, silentLogger, ID_LIST_PATTERN, parseIdList, describeRefusal } from './_cli.mjs'

const NAME = 'scripts/set-member-projects.mjs'

const SPEC = {
  'project':    { required: true, pattern: /^[a-z0-9-]{4,40}$/, help: 'Firebase project id (explicit, always)' },
  'company-id': { required: true, pattern: /^[A-Za-z0-9_-]{1,64}$/, help: "the member's company" },
  'uid':        { pattern: /^[A-Za-z0-9_-]{1,128}$/, help: "the member's uid" },
  'email':      { pattern: /^[^\s@]+@[^\s@]+\.[^\s@]+$/, help: "or the member's email (must match one active member)" },
  'set':        { pattern: ID_LIST_PATTERN, help: 'the complete new list, comma-separated' },
  'clear':      { flag: true, help: 'remove every project' },
  'add':        { pattern: ID_LIST_PATTERN, help: 'project ids to add' },
  'remove':     { pattern: ID_LIST_PATTERN, help: 'project ids to remove' },
  'apply':      { flag: true, help: 'write the change; without it nothing is written' },
}

function fatalUsage(message) {
  log.error(message)
  console.log(usage(NAME, SPEC))
  process.exit(2)
}

const list = (ids) => (ids.length ? ids.join(', ') : '(none)')

async function main() {
  let args
  try { args = parseArgs(process.argv.slice(2), SPEC) } catch (e) { fatalUsage(e.message) }
  if (!!args.uid === !!args.email) fatalUsage('Name the member with exactly one of --uid or --email')
  const modes = [args.set !== undefined, !!args.clear, args.add !== undefined || args.remove !== undefined].filter(Boolean).length
  if (modes !== 1) fatalUsage('Give exactly one of --set, --clear, or --add / --remove')
  const change = args.clear ? { set: [] }
    : args.set !== undefined ? { set: parseIdList(args.set) }
      : { ...(args.add !== undefined ? { add: parseIdList(args.add) } : {}), ...(args.remove !== undefined ? { remove: parseIdList(args.remove) } : {}) }
  const apply = !!args.apply

  const { emulated } = configureProject(args.project)
  const { getDb } = await import('../src/lib/firebaseAdmin.js')
  const { setMemberProjects, findActiveMemberUid, projectsWithoutDirectoryEntry } = await import('../src/lib/memberProjects.js')

  const db = getDb()
  const deps = { db, now: () => new Date(), log: silentLogger }
  const companyId = args['company-id']

  log.info(`${apply ? '[APPLY] ' : '[DRY RUN — read only] '}Project ${args.project}${emulated ? ' (EMULATORS)' : ''} · company ${companyId}`)

  const uid = args.uid ?? await findActiveMemberUid(db, companyId, args.email)
  // ALWAYS a read-only pass first, --apply or not: a request that will be
  // refused is refused here, in a transaction that takes no lock. The write
  // below then repeats every check inside its own transaction.
  const r = await setMemberProjects(deps, { companyId, uid, change, dryRun: true })

  log.info(`• member ${r.uid}${r.email ? ` (${r.email})` : ''} — active ${r.role}`)
  log.info(`• projects now:   ${list(r.before)}`)
  log.info(`• projects after: ${list(r.after)}`)
  if (r.added.length) log.info(`• adding:   ${list(r.added)}`)
  if (r.removed.length) log.info(`• removing: ${list(r.removed)}`)
  const gaps = await projectsWithoutDirectoryEntry(db, companyId, r.after)
  if (gaps.length > 0) log.warn(`no project-directory entry for: ${gaps.join(', ')} — assigned and readable, but absent from the member's project list until the project is saved in the app or the directory backfill is run`)

  log.info('')
  if (!r.changed) { log.info('No change: the member already holds exactly that list. Nothing written.'); return }
  if (r.after.length === 0) log.warn('The member will hold NO project and read none. To end the membership, deactivate them in the Team page instead.')
  if (!apply) {
    log.info(`Dry run — nothing written.${r.revocation ? ' Applying would also queue a file-link revocation.' : ''} Re-run with --apply.`)
    return
  }
  const done = await setMemberProjects(deps, { companyId, uid, change, dryRun: false })
  if (!done.changed) { log.info('No change: the member already held exactly that list when the write ran. Nothing written.'); return }
  log.info(`Applied, with one audit event (member.projects_changed). Projects are now: ${list(done.after)}`)
  if (done.revocation) {
    log.info(`File-link revocation queued (request ${done.fileLinkRevocationSeq}).`)
    log.warn('The removed project(s) are closed to the member now. A download URL they copied earlier may keep working until the sweep completes — see the Team page.')
  }
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
