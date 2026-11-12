#!/usr/bin/env node
// ── Operator: legacy file-link (download-token) revocation (ADR-74, DC46-B) ──
//
//   node scripts/revoke-file-links.mjs --project <id> --bucket <bucket> \
//        (--company-id <id> | --all-companies) [--execute --confirm-project <id>]
//
// DRY RUN BY DEFAULT. Without --execute this only READS: for each company in
// scope it counts the stored objects and how many still carry a Firebase
// download token, and shows the revocation state. Nothing is changed.
//
// --execute REMOVES the tokens, through exactly the code path the scheduled
// worker uses (same request record, same lease, same checkpoints, same audit
// events), so the Team page reflects the result. It is refused unless
// --confirm-project repeats the project id — a production change is never a
// slip of the keyboard.
//
// The scope is always explicit: one company, or --all-companies. There is no
// default scope.
//
// ⚠️ Token values are never printed, logged or stored. Output is counts.
// ⚠️ Removing a token cannot be undone. The app does not use tokens (ADR-73),
//    so nothing in the current build depends on them.

import { parseArgs, usage, configureProject, log } from './_cli.mjs'

const SPEC = {
  'project':         { required: true, pattern: /^[a-z0-9-]{4,40}$/, help: 'Firebase project id (explicit, always)' },
  'bucket':          { required: true, pattern: /^[a-z0-9][a-z0-9._-]{2,221}$/, help: 'Storage bucket name (explicit, always)' },
  'company-id':      { pattern: /^[A-Za-z0-9_-]{1,64}$/, help: 'one company' },
  'all-companies':   { flag: true, help: 'every company (explicit; there is no default scope)' },
  'execute':         { flag: true, help: 'REMOVE tokens; default is a read-only inventory' },
  'confirm-project': { pattern: /^[a-z0-9-]{4,40}$/, help: 'must repeat --project when --execute is given' },
  'max-minutes':     { pattern: /^[1-9][0-9]{0,2}$/, help: 'stop waiting after this many minutes (default 30)' },
}

async function main() {
  let args
  try {
    args = parseArgs(process.argv.slice(2), SPEC)
    if (!!args['company-id'] === !!args['all-companies']) throw new Error('Give exactly one scope: --company-id <id> or --all-companies')
    if (args.execute && args['confirm-project'] !== args.project) throw new Error('--execute needs --confirm-project <the same project id>')
    if (!args.execute && args['confirm-project']) throw new Error('--confirm-project is only meaningful with --execute')
  } catch (e) { log.error(e.message); log.info(usage('scripts/revoke-file-links.mjs', SPEC)); process.exit(2) }

  const { emulated } = configureProject(args.project)
  const { getDb, getBucket } = await import('../src/lib/firebaseAdmin.js')
  const { runOperator } = await import('../src/lib/fileLinkOperator.js')

  const db = getDb(), bucket = getBucket(args.bucket)
  const execute = !!args.execute

  log.info(`${execute ? '[EXECUTE] ' : '[DRY RUN — read only] '}Project ${args.project}${emulated ? ' (EMULATORS)' : ''} · bucket ${args.bucket} · ${args['company-id'] ? `company ${args['company-id']}` : 'ALL companies'}`)

  const companies = args['company-id']
    ? [await db.collection('companies').doc(args['company-id']).get()].filter(s => s.exists)
    : (await db.collection('companies').get()).docs
  if (companies.length === 0) { log.error('No matching company.'); process.exit(1) }

  const summary = await runOperator(
    { db, bucket, now: () => new Date(), out: log },
    { companyIds: companies.map(c => c.id), execute, owner: `operator:${process.pid}:${Date.now()}`, maxMs: Number(args['max-minutes'] ?? 30) * 60 * 1000 },
  )

  log.info('')
  const unfinished = summary.filter(s => s.executed && !s.complete).length
  if (!execute) log.info('Dry run: nothing was changed. Re-run with --execute --confirm-project <id> to remove the tokens.')
  else if (unfinished === 0) log.info('All companies in scope completed with zero failures.')
  else { log.warn(`${unfinished} company(ies) did not complete.`); process.exit(3) }
}

main().catch((e) => { log.error(e?.message ?? e); process.exit(1) })
