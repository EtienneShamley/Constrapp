#!/usr/bin/env node
// ── Operator: activate (or deactivate) the Phase 2 commercial programme for ONE
// company (final release batch; lib/commercialActivation.js)
//
//   node scripts/set-commercial-completion.mjs --project <firebase-project-id> \
//     --company <companyId> (--enable | --disable) --reason "<why>" [--apply]
//
// DRY RUN BY DEFAULT. Without --apply it only READS and prints what it would do.
//
// WHAT IT SWITCHES. `companies/{companyId}.commercialCompletionEnabled`. Every
// Phase 2 financial callable — the variation callables, progressClaimOperation,
// supplierInvoiceOperation, supplierSettlementOperation, the client refund /
// receipt-application callables and voidClientInvoice, contractValueOperation,
// estimateOperation, and transferBoqToBudget when it records an estimate's
// handover — acts for a company only when this is exactly `true`; for every
// other company they answer `commercial-completion-not-activated` and write
// nothing. The GLOBAL switches (VARIATION_PROCESSING_ENABLED,
// SUPPLIER_FINANCE_PROCESSING_ENABLED, CLIENT_SETTLEMENT_ENABLED,
// CONTRACT_VALUE_REVISION_ENABLED, ESTIMATING_ENABLED) stay above it as
// emergency brakes: with a switch off, an activated company is refused too.
// Refunds and applications ALSO keep their Phase 1 requirement
// (`clientFinanceEnabled`).
//
// IT DOES NOT enable approval segregation (scripts/set-approval-policy.mjs —
// a separate, optional policy), and it does not create any baseline: the
// first operation on each project does, once the company is active.
//
// WHAT IT WRITES, with --apply, in ONE transaction: the field (merged; nothing
// else of the company document is touched) and one audit event,
// `company.commercial_completion_set` (before, after, reason, source
// `operator`). A run that would change nothing writes nothing (idempotent).
// No client can write this field: the company update Rule does not list it.
//
// --disable is a BRAKE, not a reversal: nothing already posted is undone. The
// company's Phase 2 registers become read-only (the maintenance restriction)
// until it is enabled again; an operation already in flight is ordered against
// the change by Firestore (each operation re-reads the field in its own
// transaction). It names ONE company, always; only ids are printed.
//
// Exit code: 0 done (or dry run clean), 1 refused, 2 usage error.

import { parseArgs, usage, configureProject, log, runOperatorScript, releaseOnExit, UsageError, EXIT } from './_cli.mjs'

const NAME = 'scripts/set-commercial-completion.mjs'
const FIELD = 'commercialCompletionEnabled'

const SPEC = {
  'project': { required: true, pattern: /^[a-z0-9-]{4,40}$/, help: 'Firebase project id (explicit, always)' },
  'company': { required: true, pattern: /^[A-Za-z0-9_-]{1,64}$/, help: 'the ONE company to change (its document id)' },
  'enable':  { flag: true, help: 'activate the Phase 2 commercial programme for that company' },
  'disable': { flag: true, help: 'stop it for that company (a brake: nothing already posted is undone)' },
  'reason':  { required: true, pattern: /^.{10,500}$/, help: 'why (10–500 characters; recorded in the audit event)' },
  'apply':   { flag: true, help: 'write the change; without it nothing is written' },
}

const describe = (value) => (value === true ? 'ACTIVE (true)' : value === undefined ? 'not active (field absent)' : `not active (${JSON.stringify(value)})`)

async function main() {
  let args
  try { args = parseArgs(process.argv.slice(2), SPEC) } catch (e) { throw new UsageError(e.message) }
  if (!!args.enable === !!args.disable) throw new UsageError('Give exactly one of --enable or --disable')
  const target = !!args.enable
  const apply = !!args.apply
  const companyId = args.company
  const reason = String(args.reason).trim()

  const { emulated } = configureProject(args.project)
  const { getDb } = await import('../src/lib/firebaseAdmin.js')
  const { AUDIT, auditInTx } = await import('../src/lib/audit.js')
  const db = getDb()
  releaseOnExit(() => db.terminate())
  const companyRef = db.collection('companies').doc(companyId)

  log.info(`${apply ? '[APPLY] ' : '[DRY RUN — read only] '}Project ${args.project}${emulated ? ' (EMULATORS)' : ''} · company ${companyId}`)
  const snap = await companyRef.get()
  if (!snap.exists) { log.error(`Refused: company ${companyId} does not exist in project ${args.project}. Nothing written.`); return EXIT.REFUSED }
  const current = snap.data()[FIELD]
  log.info(`• ${FIELD} now:   ${describe(current)}`)
  log.info(`• ${FIELD} after: ${describe(target)}`)
  log.info(`• client finance (refunds / applications also need it): ${snap.data().clientFinanceEnabled === true ? 'active' : 'not active'}`)
  if (current === target) { log.info('No change: the company already holds exactly that value. Nothing written.'); return EXIT.OK }
  if (!apply) { log.info('Dry run — nothing written. Re-run with --apply.'); return EXIT.OK }

  const outcome = await db.runTransaction(async (tx) => {
    const fresh = await tx.get(companyRef)
    if (!fresh.exists) return 'gone'
    const before = fresh.data()[FIELD]
    if (before === target) return 'unchanged'
    tx.set(companyRef, { [FIELD]: target }, { merge: true })
    auditInTx(tx, db, companyId, {
      type: AUDIT.COMPANY_COMMERCIAL_COMPLETION_SET, actorUid: 'operator', source: 'operator',
      before: { [FIELD]: before === undefined ? null : before }, after: { [FIELD]: target, reason },
    }, new Date())
    return 'written'
  })
  if (outcome === 'gone') { log.error(`Refused: company ${companyId} no longer exists. Nothing written.`); return EXIT.REFUSED }
  if (outcome === 'unchanged') { log.info('No change when the write ran. Nothing written.'); return EXIT.OK }
  log.info(`Applied, with one audit event (company.commercial_completion_set). Company ${companyId}: ${FIELD} is now ${target}.`)
  if (target) log.info('The global switches must also be on for the callables to act. Approval segregation is NOT changed by this tool.')
  else log.warn('Nothing already posted was undone. The company\'s Phase 2 registers are read-only until it is enabled again.')
  return EXIT.OK
}

runOperatorScript(main, { usageText: usage(NAME, SPEC) })
