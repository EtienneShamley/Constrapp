#!/usr/bin/env node
// ── Operator: change ONE company's approval-segregation policy (ADR-96) ─────
//
//   node scripts/set-approval-policy.mjs --project <firebase-project-id> \
//     --company <companyId> (--enable | --disable) --reason "<why>" [--apply]
//
// DRY RUN BY DEFAULT. Without --apply it only READS and prints what it would do.
//
// WHAT IT SWITCHES. `companies/{companyId}/approvalPolicy/current
// .segregationEnabled`. Enabled, every approval in the ADR-96 matrix must be
// given by an independent authorised member — not the document's creator, a
// draft editor or its submitter — in the trusted callables AND the Rules-held
// approvals (budget versions, budget adjustments, tender awards, purchase-order
// send). Disabled (the default, and the meaning of an absent document), every
// established workflow is unchanged and single-person approval is recorded.
//
// THE OPERATOR-CONTROLLED INITIAL APPROACH (D5). No client can write the
// policy — the Rules match the document read-only — and no company
// administrator can flip it from the app. A change is made here, by the
// operator, on the company's authorised request, with a REASON, and records:
// the old and new value, the actor (`operator`), the server time, the reason,
// and an incremented version — on the document itself (`previous`) and in one
// audit event (`approval_policy.changed`).
//
// ENABLING REQUIRES TWO ELIGIBLE APPROVERS. The strictest segregated workflow
// (approved budget versions, adjustments and the Final Account) is open to
// company_admin and project_manager only, so --enable is refused unless the
// company has at least TWO ACTIVE members in those roles. This is checked at
// the moment of enabling; it never blocks removing a member later — a company
// can always deactivate a compromised account. If enforcement later leaves no
// independent approver, the affected approvals fail closed with a reason and
// the remedy is to restore an approver (team management) or to run this tool
// again with --disable and a reason.
//
// Exit code: 0 done (or dry run clean), 1 refused, 2 usage error.

import { parseArgs, usage, configureProject, log, runOperatorScript, releaseOnExit, UsageError, EXIT } from './_cli.mjs'

const NAME = 'scripts/set-approval-policy.mjs'

const SPEC = {
  'project': { required: true, pattern: /^[a-z0-9-]{4,40}$/, help: 'Firebase project id (explicit, always)' },
  'company': { required: true, pattern: /^[A-Za-z0-9_-]{1,64}$/, help: 'the ONE company to change (its document id)' },
  'enable':  { flag: true, help: 'require independent approval' },
  'disable': { flag: true, help: 'return to the default (single-person approval recorded, not refused)' },
  'reason':  { required: true, pattern: /^.{10,500}$/, help: 'why the policy is changing (10–500 characters; recorded)' },
  'apply':   { flag: true, help: 'write the change; without it nothing is written' },
}

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
  const { approvalPolicyRef, eligibleApprovers, MIN_ELIGIBLE_APPROVERS } = await import('../src/lib/approvalPolicy.js')
  const db = getDb()
  releaseOnExit(() => db.terminate())
  const companyRef = db.collection('companies').doc(companyId)
  const policyRef = approvalPolicyRef(db, companyId)

  log.info(`${apply ? '[APPLY] ' : '[DRY RUN — read only] '}Project ${args.project}${emulated ? ' (EMULATORS)' : ''} · company ${companyId}`)

  const [companySnap, policySnap, membersSnap] = await Promise.all([
    companyRef.get(), policyRef.get(), db.collection('users').where('companyId', '==', companyId).get(),
  ])
  if (!companySnap.exists) { log.error(`Refused: company ${companyId} does not exist. Nothing written.`); return EXIT.REFUSED }
  const current = policySnap.exists && policySnap.data().segregationEnabled === true
  const eligible = eligibleApprovers(membersSnap.docs.map(d => d.data()))
  log.info(`• segregation now:   ${current ? 'ENABLED' : 'disabled'}${policySnap.exists ? ` (version ${policySnap.data().version ?? '—'})` : ' (no policy document)'}`)
  log.info(`• segregation after: ${target ? 'ENABLED' : 'disabled'}`)
  log.info(`• active members able to approve every segregated workflow: ${eligible.length}`)
  // D3 #46 (ADR-98): under strict mode a purchase order or tender package
  // whose preparer was never recorded (written before `lastMaterialEditBy`
  // existed) cannot be sent / awarded by anyone until a material save records
  // it. A draft can be re-saved; an ISSUED package or a PENDING_APPROVAL PO has
  // no edit path — it must be cancelled and re-raised, or the policy left off.
  // Listed here (ids only) so the company can act BEFORE enabling.
  if (target) {
    const unstamped = []
    for (const projectSnap of (await companyRef.collection('projects').get()).docs) {
      const [pos, tenders] = await Promise.all([
        projectSnap.ref.collection('purchaseOrders').where('status', 'in', ['draft', 'pending_approval']).get(),
        projectSnap.ref.collection('tenderPackages').where('status', 'in', ['draft', 'issued']).get(),
      ])
      for (const d of [...pos.docs, ...tenders.docs]) {
        if (typeof d.data().lastMaterialEditBy !== 'string') unstamped.push(`${projectSnap.id}/${d.ref.parent.id}/${d.id} (${d.data().status})`)
      }
    }
    log.info(`• open POs / tender packages with no recorded preparer: ${unstamped.length}`)
    for (const u of unstamped.slice(0, 50)) log.warn(`  ${u} — cannot be sent / awarded under segregation until a material save records its preparer (issued / pending_approval: cancel and re-raise)`)
    if (unstamped.length > 50) log.warn(`  … and ${unstamped.length - 50} more`)
  }
  if (current === target) { log.info('No change. Nothing written.'); return EXIT.OK }
  if (target && eligible.length < MIN_ELIGIBLE_APPROVERS) {
    log.error(`Refused: enabling segregation needs at least ${MIN_ELIGIBLE_APPROVERS} active company_admin or project_manager members; this company has ${eligible.length}. Nothing written.`)
    return EXIT.REFUSED
  }
  if (!apply) { log.info('Dry run — nothing written. Re-run with --apply.'); return EXIT.OK }

  const outcome = await db.runTransaction(async (tx) => {
    const fresh = await tx.get(policyRef)
    const before = fresh.exists ? fresh.data() : null
    if ((before?.segregationEnabled === true) === target) return 'unchanged'
    if (target) {
      const members = await tx.get(db.collection('users').where('companyId', '==', companyId))
      if (eligibleApprovers(members.docs.map(d => d.data())).length < MIN_ELIGIBLE_APPROVERS) return 'ineligible'
    }
    const version = (Number.isSafeInteger(before?.version) ? before.version : 0) + 1
    const now = new Date()
    tx.set(policyRef, {
      segregationEnabled: target, version, changedAt: now, changedBy: 'operator', reason,
      previous: before ? { segregationEnabled: before.segregationEnabled === true, version: before.version ?? null } : null,
    })
    auditInTx(tx, db, companyId, {
      type: AUDIT.APPROVAL_POLICY_CHANGED, actorUid: 'operator', source: 'operator',
      before: { segregationEnabled: before?.segregationEnabled === true, version: before?.version ?? null },
      after: { segregationEnabled: target, version, reason },
    }, now)
    return 'written'
  })
  if (outcome === 'unchanged') { log.info('No change when the write ran. Nothing written.'); return EXIT.OK }
  if (outcome === 'ineligible') { log.error('Refused: the eligible approvers changed while the write ran. Nothing written.'); return EXIT.REFUSED }
  log.info(`Applied, with one audit event (approval_policy.changed). Company ${companyId}: segregation is now ${target ? 'ENABLED' : 'disabled'}.`)
  return EXIT.OK
}

runOperatorScript(main, { usageText: usage(NAME, SPEC) })
