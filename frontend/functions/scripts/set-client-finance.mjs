#!/usr/bin/env node
// ── Operator: activate client credit notes and retention releases for ONE
// company (ADR-89)
//
//   node scripts/set-client-finance.mjs --project <firebase-project-id> \
//     --company <companyId> [--receipts] (--enable | --disable) [--apply]
//
// DRY RUN BY DEFAULT. Without --apply it only READS the company document and
// prints what it would change.
//
// WHAT IT SWITCHES. The four trusted callables postClientCreditNote,
// voidClientCreditNote, postClientRetentionRelease and
// voidClientRetentionRelease act for a company only when its company document
// carries `clientFinanceEnabled: true`; for every other company they answer
// `client-finance-not-activated` and write nothing. The global switch
// CLIENT_FINANCE_POSTING_ENABLED is the brake above this: with it off, an
// activated company is refused too. Client RECEIPTS are not affected by this
// flag.
//
// WITH --receipts it switches the OTHER, independent flag instead:
// `clientReceiptsEnabled`, which lets postClientReceipt and voidClientReceipt
// act for that company while CLIENT_RECEIPT_ALL_COMPANIES is false (the
// cutover: the TEST company first). Once that parameter is true the flag is
// not consulted. Neither flag implies the other. Audit event:
// `company.client_receipts_set`.
//
// WHAT IT WRITES, with --apply, in one transaction:
//   · `clientFinanceEnabled` (true or false) on companies/{companyId} — that
//     field ONLY, merged; nothing else of the company document is touched;
//   · one audit event, `company.client_finance_set` (the value before and
//     after, source `operator`).
// A run that would change nothing writes nothing — no field, no audit event.
//
// No client can write this field: the company update Rule lists the keys a
// client may change, and this is not one of them.
//
// It names ONE company, always: there is no option for all companies, and an
// unknown company id is refused. Only ids are printed — never a company name.
//
// --disable does not undo anything already posted. Posted credit notes and
// releases stay posted and keep counting; they simply cannot be voided, and no
// new one posted, until the company is enabled again.
//
// Exit code: 0 done (or dry run clean), 1 refused, 2 usage error.

import { parseArgs, usage, configureProject, log, runOperatorScript, releaseOnExit, UsageError, EXIT } from './_cli.mjs'

const NAME = 'scripts/set-client-finance.mjs'

const SPEC = {
  'project': { required: true, pattern: /^[a-z0-9-]{4,40}$/, help: 'Firebase project id (explicit, always)' },
  'company': { required: true, pattern: /^[A-Za-z0-9_-]{1,64}$/, help: 'the ONE company to change (its document id)' },
  'receipts': { flag: true, help: 'switch trusted RECEIPT processing (clientReceiptsEnabled) instead of credit notes and releases' },
  'enable':  { flag: true, help: 'allow the feature for that company' },
  'disable': { flag: true, help: 'stop it for that company (nothing already posted is undone)' },
  'apply':   { flag: true, help: 'write the change; without it nothing is written' },
}

// Strictly `=== true`, exactly as the callables read it (src/lib/clientEntryShape.js).
const describe = (value) => (value === true ? 'ENABLED (true)' : value === undefined ? 'not enabled (field absent)' : `not enabled (${JSON.stringify(value)})`)

async function main() {
  let args
  try { args = parseArgs(process.argv.slice(2), SPEC) } catch (e) { throw new UsageError(e.message) }
  if (!!args.enable === !!args.disable) throw new UsageError('Give exactly one of --enable or --disable')
  const target = !!args.enable
  const apply = !!args.apply
  const companyId = args.company
  const receipts = !!args.receipts
  const FIELD = receipts ? 'clientReceiptsEnabled' : 'clientFinanceEnabled'

  const { emulated } = configureProject(args.project)
  const { getDb } = await import('../src/lib/firebaseAdmin.js')
  const { AUDIT, auditInTx } = await import('../src/lib/audit.js')
  const db = getDb()
  releaseOnExit(() => db.terminate())
  const companyRef = db.collection('companies').doc(companyId)

  log.info(`${apply ? '[APPLY] ' : '[DRY RUN — read only] '}Project ${args.project}${emulated ? ' (EMULATORS)' : ''} · company ${companyId}`)

  // ALWAYS a read-only pass first, --apply or not: a request that will be
  // refused is refused here, before any transaction.
  const snap = await companyRef.get()
  if (!snap.exists) { log.error(`Refused: company ${companyId} does not exist in project ${args.project}. Nothing written.`); return EXIT.REFUSED }
  const current = snap.data()[FIELD]
  log.info(`• ${FIELD} now:   ${describe(current)}`)
  log.info(`• ${FIELD} after: ${describe(target)}`)
  log.info('')

  // Already exactly the requested boolean (an absent field is not `false`:
  // --disable on a company that never had it records the explicit value).
  if (current === target) { log.info('No change: the company already holds exactly that value. Nothing written.'); return EXIT.OK }
  if (!apply) { log.info('Dry run — nothing written. Re-run with --apply.'); return EXIT.OK }

  const outcome = await db.runTransaction(async (tx) => {
    const fresh = await tx.get(companyRef)
    if (!fresh.exists) return 'gone'
    const before = fresh.data()[FIELD]
    if (before === target) return 'unchanged'
    tx.set(companyRef, { [FIELD]: target }, { merge: true })
    auditInTx(tx, db, companyId, {
      type: receipts ? AUDIT.COMPANY_CLIENT_RECEIPTS_SET : AUDIT.COMPANY_CLIENT_FINANCE_SET, actorUid: 'operator', source: 'operator',
      before: { [FIELD]: before === undefined ? null : before }, after: { [FIELD]: target },
    }, new Date())
    return 'written'
  })
  if (outcome === 'gone') { log.error(`Refused: company ${companyId} no longer exists. Nothing written.`); return EXIT.REFUSED }
  if (outcome === 'unchanged') { log.info('No change: the company already held exactly that value when the write ran. Nothing written.'); return EXIT.OK }
  log.info(`Applied, with one audit event (${receipts ? 'company.client_receipts_set' : 'company.client_finance_set'}). Company ${companyId}: ${FIELD} is now ${target}.`)
  if (receipts) log.info(target ? 'The global switch CLIENT_RECEIPT_POSTING_ENABLED must also be on for the two receipt callables to act.' : 'Nothing already posted was undone. While CLIENT_RECEIPT_ALL_COMPANIES is false this company can no longer post or void a receipt.')
  else if (target) log.info('The global switch CLIENT_FINANCE_POSTING_ENABLED must also be on for the four callables to act.')
  else log.warn('Nothing already posted was undone. Posted credit notes and releases stay posted and cannot be voided while the company is disabled.')
  return EXIT.OK
}

// Never process.exit() here: see runOperatorScript in _cli.mjs. A refused or
// failed transaction is reported once and never retried.
runOperatorScript(main, { usageText: usage(NAME, SPEC) })
