#!/usr/bin/env node
// ── Operator: bootstrap a company and its first Company Admin (ADR-72) ───────
//
//   node scripts/bootstrap-company.mjs --project <firebase-project-id> \
//     --company-id acme-builders --company-name "Acme Builders" \
//     --admin-email ada@acme.example [--country AU --currency AUD] [--dry-run]
//
// What it does, idempotently:
//   1. creates companies/{company-id} if absent (refuses if it exists under a
//      DIFFERENT name — that is ambiguous, not a retry)
//   2. if the email is already an active company_admin there: nothing to do
//   3. otherwise issues (or ROTATES, if one is pending) an OPERATOR-DELIVERED
//      company_admin invitation and PRINTS the acceptance link once. The link
//      is the only copy; hand it to the admin over a channel you trust. The
//      operator link proves nothing about the mailbox, so the account is NOT
//      marked email-verified on acceptance.
//   4. writes `company.bootstrapped` / `invite.*` audit events
//
// There is deliberately NO public tenant registration: this script is the
// only way a company comes into existence.

import { parseArgs, usage, configureProject, log, silentLogger } from './_cli.mjs'

const SPEC = {
  'project':      { required: true, pattern: /^[a-z0-9-]{4,40}$/, help: 'Firebase project id (explicit, always)' },
  'company-id':   { required: true, pattern: /^[a-z0-9][a-z0-9-]{2,39}$/, help: 'stable slug, lowercase letters/digits/hyphens' },
  'company-name': { required: true, pattern: /^.{2,120}$/, help: 'display name' },
  'admin-email':  { required: true, pattern: /^[^\s@]+@[^\s@]+\.[^\s@]+$/, help: 'first Company Admin email' },
  'country':      { pattern: /^[A-Z]{2}$/, help: 'ISO 3166-1 alpha-2, optional' },
  'currency':     { pattern: /^[A-Z]{3}$/, help: 'ISO 4217, optional' },
  'app-url':      { pattern: /^https?:\/\/\S+$/, help: 'origin for the acceptance link (defaults to APP_BASE_URL env)' },
  'dry-run':      { flag: true, help: 'print the plan, change nothing' },
}

async function main() {
  let args
  try { args = parseArgs(process.argv.slice(2), SPEC) } catch (e) { log.error(e.message); console.log(usage('scripts/bootstrap-company.mjs', SPEC)); process.exit(2) }
  const { emulated } = configureProject(args.project)
  const appBaseUrl = args['app-url'] ?? process.env.APP_BASE_URL ?? ''
  if (!appBaseUrl) { log.error('--app-url (or APP_BASE_URL) is required to build the acceptance link.'); process.exit(2) }

  const { getDb, getAdminAuth, Timestamp } = await import('../src/lib/firebaseAdmin.js')
  const { createInvitation, lookupAuthUserByEmail, DELIVERY } = await import('../src/lib/invitations.js')
  const { isActiveAdminOf, isActiveMemberOf } = await import('../src/lib/membershipState.js')
  const { auditNow, AUDIT } = await import('../src/lib/audit.js')
  const { normaliseEmail } = await import('../src/lib/validation.js')

  const db = getDb(), auth = getAdminAuth()
  const now = () => new Date()
  const deps = {
    db, auth, now, log: silentLogger,
    email: { kind: 'none', async send() { throw new Error('bootstrap never emails') } },
    config: () => ({ appBaseUrl, emailFrom: '', enabled: true, inviteTtlMs: 7 * 24 * 60 * 60 * 1000 }),
  }
  const companyId = args['company-id']
  const email = normaliseEmail(args['admin-email'])
  const dry = !!args['dry-run']
  const actor = { uid: 'operator', name: 'Operator' }

  log.info(`${dry ? '[DRY RUN] ' : ''}Project ${args.project}${emulated ? ' (EMULATORS)' : ''} · company ${companyId} · admin ${email}`)

  // 1. Company
  const companyRef = db.collection('companies').doc(companyId)
  const companySnap = await companyRef.get()
  if (companySnap.exists) {
    if (companySnap.data().name !== args['company-name']) {
      log.error(`companies/${companyId} exists with name "${companySnap.data().name}", not "${args['company-name']}". Refusing an ambiguous change.`)
      process.exit(1)
    }
    log.info(`• company exists — reused`)
  } else {
    const data = { name: args['company-name'], createdAt: Timestamp.fromDate(now()), createdBy: 'operator' }
    if (args.country) data.countryCode = args.country
    if (args.currency) data.baseCurrency = args.currency
    log.info(`• create companies/${companyId} ${JSON.stringify({ name: data.name, countryCode: data.countryCode ?? null, baseCurrency: data.baseCurrency ?? null })}`)
    if (!dry) {
      await companyRef.set(data)
      await auditNow(db, companyId, { type: AUDIT.COMPANY_BOOTSTRAPPED, actorUid: 'operator', after: { name: data.name }, source: 'operator' }, now())
    }
  }

  // 2. Already an admin?
  const authUser = await lookupAuthUserByEmail(auth, email)
  if (authUser) {
    const profile = await db.collection('users').doc(authUser.uid).get()
    const p = profile.exists ? profile.data() : null
    if (isActiveAdminOf(p, companyId)) { log.info(`• ${email} is already an active Company Admin (uid ${authUser.uid}). Nothing to do.`); return }
    if (isActiveMemberOf(p, companyId)) { log.error(`• ${email} is an active ${p.role} of this company. Change the role in the app instead.`); process.exit(1) }
    if (p && p.companyId && p.companyId !== companyId && p.status !== 'deactivated') { log.error(`• ${email} is an active member of another company. Refusing.`); process.exit(1) }
  }

  // 3. Invitation (operator-delivered): rotate if pending, else create.
  const pending = await companyRef.collection('invitations').where('email', '==', email).where('status', '==', 'pending').get()
  if (dry) {
    log.info(pending.empty ? `• would create an operator-delivered company_admin invitation for ${email}` : `• would rotate the pending invitation ${pending.docs[0].id}`)
    log.info('Dry run complete — nothing written.')
    return
  }
  let result
  if (pending.empty) {
    result = await createInvitation(deps, { companyId, actor, email, role: 'company_admin', deliveredVia: DELIVERY.OPERATOR, source: 'operator' })
  } else {
    const inviteId = pending.docs[0].id
    // Rotate through the shared path, but keep it operator-delivered and never email.
    const { generateToken, hashToken, buildInviteLink } = await import('../src/lib/tokens.js')
    const token = generateToken()
    const expiresAt = new Date(now().getTime() + deps.config().inviteTtlMs)
    const { withCompanyLock } = await import('../src/lib/companyLock.js')
    const { auditInTx } = await import('../src/lib/audit.js')
    await withCompanyLock(db, companyId, now(), async (tx) => {
      const snap = await tx.get(pending.docs[0].ref)
      tx.update(pending.docs[0].ref, {
        tokenHash: hashToken(token), previousTokenHash: snap.data().tokenHash, expiresAt: Timestamp.fromDate(expiresAt),
        failedAttempts: 0, deliveredVia: DELIVERY.OPERATOR, updatedAt: Timestamp.fromDate(now()),
      })
      auditInTx(tx, db, companyId, { type: AUDIT.INVITE_RESENT, actorUid: 'operator', targetEmail: email, inviteId, after: { expiresAt: expiresAt.toISOString(), deliveredVia: DELIVERY.OPERATOR }, source: 'operator' }, now())
    })
    result = { inviteId, expiresAt: expiresAt.toISOString(), link: buildInviteLink(appBaseUrl, { companyId, inviteId, token }) }
  }

  log.info(`• invitation ${result.inviteId} (expires ${result.expiresAt})`)
  log.info('')
  log.info('ACCEPTANCE LINK — shown once, hand it to the admin over a trusted channel:')
  log.info(result.link)
  log.info('')
}

main().catch((e) => { log.error(e?.message ?? e); process.exit(1) })
