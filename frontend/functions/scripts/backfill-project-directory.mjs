#!/usr/bin/env node
// ── Operator: backfill the project directory (M2-A2) ─────────────────────────
//
//   node scripts/backfill-project-directory.mjs --project <firebase-project-id> \
//     [--company-id <id>] [--apply]
//
// DRY-RUN BY DEFAULT. Without --apply it reads and reports; it writes nothing.
//
// A directory entry — companies/{c}/projectDirectory/{projectId} — is the
// external-safe copy of a project's name, status, location, startDate and
// progress. The app writes it with every project create and edit; a project
// that pre-dates M2-A2 has none until it is edited. This script creates the
// MISSING entries, and only those:
//
//   IN SYNC    an entry exists and equals the project           → left alone
//   MISSING    no entry, and the five source values are sound   → created (--apply)
//   INVALID    a source value has the wrong type                → REFUSED, reported
//   MISMATCH   an entry exists and differs from the project     → REFUSED, reported
//   ORPHAN     an entry exists for a project that does not      → reported
//
// It never overwrites, never deletes and never touches a project document.
// Each create runs in a transaction that RE-READS the project and the entry,
// so a project edited or an entry written meanwhile is not clobbered. A
// MISMATCH or INVALID is fixed by a person: saving the project in the app
// rewrites both documents together under the rules.
//
// A missing entry exposes nothing — it only keeps that project out of an
// assigned client's or subcontractor's list. Exit code: 0 clean, 1 when any
// project was refused or failed, 2 on a usage error.

import { parseArgs, usage, configureProject, log } from './_cli.mjs'
import { expectedEntry, entryDifferences } from './_projectDirectory.mjs'

const SPEC = {
  'project':    { required: true, pattern: /^[a-z0-9-]{4,40}$/, help: 'Firebase project id (explicit, always)' },
  'company-id': { pattern: /^[A-Za-z0-9_-]{1,64}$/, help: 'limit to one company (default: all)' },
  'apply':      { flag: true, help: 'create the missing entries; without it nothing is written' },
}

async function main() {
  let args
  try { args = parseArgs(process.argv.slice(2), SPEC) } catch (e) { log.error(e.message); console.log(usage('scripts/backfill-project-directory.mjs', SPEC)); process.exit(2) }
  const { emulated } = configureProject(args.project)
  const { getDb } = await import('../src/lib/firebaseAdmin.js')
  const db = getDb()
  const apply = !!args.apply

  log.info(`${apply ? '[APPLY] ' : '[DRY RUN] '}Project ${args.project}${emulated ? ' (EMULATORS)' : ''}${args['company-id'] ? ` · company ${args['company-id']}` : ' · all companies'}`)

  const companies = args['company-id']
    ? [await db.collection('companies').doc(args['company-id']).get()].filter(s => s.exists)
    : (await db.collection('companies').get()).docs
  if (args['company-id'] && companies.length === 0) { log.error('Company not found.'); process.exit(1) }

  const totals = { projects: 0, inSync: 0, missing: 0, created: 0, invalid: 0, mismatch: 0, orphan: 0, failed: 0 }

  for (const company of companies) {
    const companyRef = db.collection('companies').doc(company.id)
    const [projects, entries] = await Promise.all([
      companyRef.collection('projects').get(),
      companyRef.collection('projectDirectory').get(),
    ])
    const entryById = new Map(entries.docs.map(d => [d.id, d.data()]))
    const projectIds = new Set(projects.docs.map(d => d.id))
    log.info(`\nCompany ${company.id} — ${projects.size} project(s), ${entries.size} directory entr${entries.size === 1 ? 'y' : 'ies'}`)

    for (const p of projects.docs) {
      totals.projects += 1
      const where = `companies/${company.id}/projects/${p.id}`
      const { entry, problems } = expectedEntry(p.data())
      if (problems.length) {
        totals.invalid += 1
        log.error(`INVALID   ${where} — ${problems.join('; ')}`)
        continue
      }
      if (entryById.has(p.id)) {
        const diffs = entryDifferences(entryById.get(p.id), entry)
        if (diffs.length === 0) { totals.inSync += 1; continue }
        totals.mismatch += 1
        log.error(`MISMATCH  ${where} — ${diffs.join('; ')} (refused; never overwritten)`)
        continue
      }
      totals.missing += 1
      if (!apply) { log.info(`MISSING   ${where} — would create its directory entry`); continue }
      try {
        const outcome = await db.runTransaction(async (tx) => {
          const dirRef = companyRef.collection('projectDirectory').doc(p.id)
          const [fresh, existing] = await tx.getAll(p.ref, dirRef)
          if (!fresh.exists) return 'project disappeared'
          if (existing.exists) return 'an entry appeared meanwhile'
          const again = expectedEntry(fresh.data())
          if (again.problems.length) return `source changed and is now invalid: ${again.problems.join('; ')}`
          tx.create(dirRef, again.entry)
          return null
        })
        if (outcome) { totals.failed += 1; log.error(`SKIPPED   ${where} — ${outcome}; run again`) }
        else { totals.created += 1; log.info(`CREATED   ${where}`) }
      } catch (e) {
        totals.failed += 1
        log.error(`FAILED    ${where} — ${e?.message ?? e}`)
      }
    }

    for (const id of entryById.keys()) {
      if (projectIds.has(id)) continue
      totals.orphan += 1
      log.error(`ORPHAN    companies/${company.id}/projectDirectory/${id} — no such project (left alone)`)
    }
  }

  log.info('')
  log.info(`Projects ${totals.projects} · in sync ${totals.inSync} · missing ${totals.missing}${apply ? ` · created ${totals.created}` : ''} · invalid ${totals.invalid} · mismatch ${totals.mismatch} · orphan ${totals.orphan} · failed ${totals.failed}`)
  if (!apply && totals.missing > 0) log.info('Dry run — nothing written. Re-run with --apply to create the missing entries.')
  if (!apply && totals.missing === 0) log.info('Dry run — nothing to create.')

  const refused = totals.invalid + totals.mismatch + totals.orphan + totals.failed
  if (refused > 0) { log.error(`${refused} item(s) need attention — see above.`); process.exit(1) }
}

main().catch((e) => { log.error(e?.message ?? e); process.exit(1) })
