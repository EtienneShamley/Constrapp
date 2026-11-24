#!/usr/bin/env node
// ── Operator: bootstrap a company and its first Company Admin (ADR-72) ───────
//
//   node scripts/bootstrap-company.mjs --project <firebase-project-id> \
//     --company-id acme-builders --company-name "Acme Builders" \
//     --admin-email ada@acme.example [--country AU --currency AUD] \
//     [--apply (--no-link | --link-file <path> [--app-url <origin>])] [--rotate]
//
// DRY RUN BY DEFAULT. Without --apply it only READS: it checks the company,
// the email and any pending invitation, prints the plan and writes nothing.
// `--dry-run` is still accepted (it is the default) and cannot be combined
// with --apply.
//
// With --apply, idempotently:
//   1. creates companies/{company-id} if absent, with its `company.bootstrapped`
//      audit event in the same commit (refuses if it exists under a DIFFERENT
//      name — that is ambiguous, not a retry)
//   2. if the email is already an active company_admin there: nothing to do
//   3. otherwise issues an OPERATOR-DELIVERED company_admin invitation
//      (`invite.created`). The operator link proves nothing about the mailbox,
//      so the account is NOT marked email-verified on acceptance.
//
// A PENDING invitation for the email is never replaced silently. The run is
// refused unless --rotate is given; --rotate gives that same invitation a new
// token (`invite.resent`) — the link handed out before stops working, and no
// second invitation is created.
//
// ⚠️ THE ACCEPTANCE LINK IS A CREDENTIAL AND IS NEVER PRINTED. With --apply
// choose exactly one:
//
//   --link-file <path>   the link is written to a NEW file, mode 0600,
//                        outside this repository (see _linkFile.mjs). Hand it
//                        over on a channel you trust, then delete the file.
//   --no-link            the link is discarded. Deliver it later with
//                        `--apply --rotate --link-file <path>`, or — when the
//                        company already has an active Company Admin — by
//                        Settings → Team → Resend, which emails a fresh link.
//
// If the invitation commits but the link file cannot be written, the script
// exits 3, names the invitation and removes the partial file. Recover with
// `--apply --rotate --link-file <new path>` — see DEPLOYMENT.md.
//
// There is deliberately NO public tenant registration: this script is the
// only way a company comes into existence.
//
// Exit code: 0 done (or dry run / nothing to do), 1 refused or failed,
// 2 usage error, 3 invitation committed but the link file was not written.

import { parseArgs, usage, configureProject, log, silentLogger, describeRefusal, runOperatorScript, releaseOnExit, UsageError, EXIT } from './_cli.mjs'
import { checkLinkFileDestination, reserveLinkFile, deliverToLinkFile, discardLinkFile, redactCredentials, LinkFileError } from './_linkFile.mjs'

const NAME = 'scripts/bootstrap-company.mjs'
const EXIT_LINK_NOT_DELIVERED = 3

const SPEC = {
  'project':      { required: true, pattern: /^[a-z0-9-]{4,40}$/, help: 'Firebase project id (explicit, always)' },
  'company-id':   { required: true, pattern: /^[a-z0-9][a-z0-9-]{2,39}$/, help: 'stable slug, lowercase letters/digits/hyphens' },
  'company-name': { required: true, pattern: /^.{2,120}$/, help: 'display name' },
  'admin-email':  { required: true, pattern: /^[^\s@]+@[^\s@]+\.[^\s@]+$/, help: 'first Company Admin email' },
  'country':      { pattern: /^[A-Z]{2}$/, help: 'ISO 3166-1 alpha-2, optional' },
  'currency':     { pattern: /^[A-Z]{3}$/, help: 'ISO 4217, optional' },
  'apply':        { flag: true, help: 'write; without it nothing is written' },
  'dry-run':      { flag: true, help: 'read only — the default; kept for older commands' },
  'no-link':      { flag: true, help: 'with --apply: discard the link (deliver it later)' },
  'link-file':    { pattern: /^.{1,1024}$/, help: 'with --apply: write the link to this NEW file (mode 0600, outside the repository)' },
  'app-url':      { pattern: /^https?:\/\/[^\s/]+$/, help: 'origin for the link file (defaults to APP_BASE_URL env)' },
  'rotate':       { flag: true, help: 'replace the token of the PENDING invitation for this email (the old link stops working)' },
}

const ROTATE_HINT = 're-run with --rotate to give it a new link (the old one stops working), or revoke it in Settings → Team'

// Every check, no write. Returns the plan or a refusal message.
async function plan({ db, auth, lookupAuthUserByEmail, isActiveAdminOf, isActiveMemberOf }, { companyId, companyName, email, rotate }) {
  const companyRef = db.collection('companies').doc(companyId)
  const companySnap = await companyRef.get()
  let company = 'create'
  if (companySnap.exists) {
    if (companySnap.data().name !== companyName) return { refused: `companies/${companyId} exists with name "${companySnap.data().name}", not "${companyName}". Refusing an ambiguous change.` }
    company = 'reuse'
  }

  const authUser = await lookupAuthUserByEmail(auth, email)
  if (authUser) {
    const snap = await db.collection('users').doc(authUser.uid).get()
    const p = snap.exists ? snap.data() : null
    if (isActiveAdminOf(p, companyId)) return { company, nothing: `${email} is already an active Company Admin (uid ${authUser.uid}). Nothing to do.` }
    if (isActiveMemberOf(p, companyId)) return { refused: `${email} is an active ${p.role} of this company. Change the role in the app instead.` }
    if (p && p.companyId && p.companyId !== companyId && p.status !== 'deactivated') return { refused: `${email} is an active member of another company. Refusing.` }
  }

  const pending = company === 'reuse'
    ? (await companyRef.collection('invitations').where('email', '==', email).where('status', '==', 'pending').get()).docs
    : []
  if (pending.length > 1) return { refused: `${pending.length} pending invitations exist for ${email} (${pending.map(d => d.id).join(', ')}). Revoke the extra ones in Settings → Team first.` }
  const existing = pending[0] ?? null
  if (existing && existing.data().role !== 'company_admin') return { refused: `the pending invitation ${existing.id} for ${email} is for the role ${existing.data().role}, not company_admin. Revoke it in Settings → Team first.` }
  if (existing && !rotate) return { refused: `a pending company_admin invitation ${existing.id} already exists for ${email}: ${ROTATE_HINT}.` }
  if (!existing && rotate) return { refused: `--rotate: there is no pending invitation for ${email} to rotate. Re-run without --rotate to create one.` }
  return { company, invitation: existing ? 'rotate' : 'create', inviteId: existing?.id ?? null }
}

async function main() {
  let args
  try { args = parseArgs(process.argv.slice(2), SPEC) } catch (e) { throw new UsageError(e.message) }
  const apply = !!args.apply
  const rotate = !!args.rotate
  if (apply && args['dry-run']) throw new UsageError('--apply and --dry-run contradict each other')
  if (apply && !!args['no-link'] === !!args['link-file']) throw new UsageError('--apply needs exactly one of --no-link or --link-file <path>')
  if (!apply && (args['no-link'] || args['link-file'])) throw new UsageError('--no-link and --link-file are only meaningful with --apply')
  if (apply && args['no-link'] && args['app-url']) throw new UsageError('--app-url only builds the link for --link-file; it is meaningless with --no-link')

  const { emulated } = configureProject(args.project)
  const appBaseUrl = args['app-url'] ?? process.env.APP_BASE_URL ?? ''
  if (args['app-url'] && !emulated && !args['app-url'].startsWith('https://')) throw new UsageError('--app-url must be an https origin outside the emulators')
  let linkFile = null
  if (args['link-file']) {
    if (!appBaseUrl) throw new UsageError('--link-file needs --app-url (or APP_BASE_URL) to build the acceptance link')
    if (!emulated && !appBaseUrl.startsWith('https://')) throw new UsageError('the link origin must be https outside the emulators')
    try { linkFile = checkLinkFileDestination(args['link-file']) } catch (e) { throw new UsageError(e.message) }
  }

  const { getDb, getAdminAuth, Timestamp } = await import('../src/lib/firebaseAdmin.js')
  const { createInvitation, lookupAuthUserByEmail, DELIVERY } = await import('../src/lib/invitations.js')
  const { isActiveAdminOf, isActiveMemberOf } = await import('../src/lib/membershipState.js')
  const { auditInTx, AUDIT } = await import('../src/lib/audit.js')
  const { normaliseEmail } = await import('../src/lib/validation.js')

  const db = getDb(), auth = getAdminAuth()
  releaseOnExit(() => db.terminate())
  const now = () => new Date()
  const deps = {
    db, auth, now, log: silentLogger,
    email: { kind: 'none', async send() { throw new Error('bootstrap never emails') } },
    config: () => ({ appBaseUrl: linkFile ? appBaseUrl : '', emailFrom: '', enabled: true, inviteTtlMs: 7 * 24 * 60 * 60 * 1000 }),
  }
  const companyId = args['company-id']
  const companyName = args['company-name']
  const email = normaliseEmail(args['admin-email'])
  const actor = { uid: 'operator', name: 'Operator' }

  log.info(`${apply ? '[APPLY] ' : '[DRY RUN — read only] '}Project ${args.project}${emulated ? ' (EMULATORS)' : ''} · company ${companyId} · admin ${email}`)

  // ALWAYS a read-only pass first, --apply or not: a request that will be
  // refused is refused here, before any file or document is created.
  const p = await plan({ db, auth, lookupAuthUserByEmail, isActiveAdminOf, isActiveMemberOf }, { companyId, companyName, email, rotate })
  if (p.refused) { log.error(p.refused); return EXIT.REFUSED }
  log.info(p.company === 'reuse' ? '• company exists — reused' : `• ${apply ? 'will ' : 'would '}create companies/${companyId} ${JSON.stringify({ name: companyName, countryCode: args.country ?? null, baseCurrency: args.currency ?? null })}`)
  if (p.nothing) {
    log.info(`• ${p.nothing}`)
    if (p.company === 'reuse') return EXIT.OK
  } else {
    log.info(p.invitation === 'create'
      ? `• ${apply ? 'will ' : 'would '}create an operator-delivered company_admin invitation for ${email}`
      : `• ${apply ? 'will ' : 'would '}ROTATE the pending invitation ${p.inviteId}: the link handed out before stops working`)
  }

  if (!apply) {
    log.info('')
    log.info('Dry run — nothing written. Re-run with --apply and exactly one of --no-link or --link-file <path>.')
    return EXIT.OK
  }

  // Reserve the link file BEFORE any write, so the link is never created
  // without a private place to put it, and a bad destination writes nothing.
  let reserved = null
  if (linkFile && !p.nothing) {
    try { reserved = reserveLinkFile(linkFile) } catch (e) { if (e instanceof LinkFileError) { log.error(e.message); return EXIT.REFUSED } throw e }
  }
  try {
    // 1. Company — created with its audit event in ONE commit, re-checked inside.
    if (p.company === 'create') {
      const companyRef = db.collection('companies').doc(companyId)
      const created = await db.runTransaction(async (tx) => {
        const snap = await tx.get(companyRef)
        if (snap.exists) {
          if (snap.data().name !== companyName) return `companies/${companyId} was created meanwhile with name "${snap.data().name}". Refusing.`
          return null
        }
        const data = { name: companyName, createdAt: Timestamp.fromDate(now()), createdBy: 'operator' }
        if (args.country) data.countryCode = args.country
        if (args.currency) data.baseCurrency = args.currency
        tx.create(companyRef, data)
        auditInTx(tx, db, companyId, { type: AUDIT.COMPANY_BOOTSTRAPPED, actorUid: 'operator', after: { name: data.name }, source: 'operator' }, now())
        return null
      })
      if (created) { log.error(created); return EXIT.REFUSED }
      log.info(`• company ${companyId} created`)
    }
    if (p.nothing) return EXIT.OK

    // 2. Invitation (operator-delivered).
    let result
    if (p.invitation === 'create') {
      result = await createInvitation(deps, { companyId, actor, email, role: 'company_admin', deliveredVia: DELIVERY.OPERATOR, source: 'operator' })
    } else {
      const { generateToken, hashToken, buildInviteLink } = await import('../src/lib/tokens.js')
      const { withCompanyLock } = await import('../src/lib/companyLock.js')
      const token = generateToken()
      const expiresAt = new Date(now().getTime() + deps.config().inviteTtlMs)
      const ref = db.collection('companies').doc(companyId).collection('invitations').doc(p.inviteId)
      const refusal = await withCompanyLock(db, companyId, now(), async (tx) => {
        const snap = await tx.get(ref)
        const d = snap.exists ? snap.data() : null
        // Re-checked under the lock: accepted, revoked or changed since the plan.
        if (!d || d.status !== 'pending' || d.email !== email || d.role !== 'company_admin') {
          throw Object.assign(new Error(`the invitation ${p.inviteId} is no longer a pending company_admin invitation for ${email}; nothing rotated`), { bootstrapRefusal: true })
        }
        tx.update(ref, {
          tokenHash: hashToken(token), previousTokenHash: d.tokenHash, expiresAt: Timestamp.fromDate(expiresAt),
          failedAttempts: 0, deliveredVia: DELIVERY.OPERATOR, updatedAt: Timestamp.fromDate(now()),
        })
        auditInTx(tx, db, companyId, { type: AUDIT.INVITE_RESENT, actorUid: 'operator', targetEmail: email, inviteId: p.inviteId, after: { expiresAt: expiresAt.toISOString(), deliveredVia: DELIVERY.OPERATOR }, source: 'operator' }, now())
        return null
      }).catch((e) => { if (e?.bootstrapRefusal) return e.message; throw e })
      if (refusal) { log.error(refusal); return EXIT.REFUSED }
      result = { inviteId: p.inviteId, expiresAt: expiresAt.toISOString(), link: buildInviteLink(appBaseUrl || 'http://localhost', { companyId, inviteId: p.inviteId, token }) }
    }
    const what = p.invitation === 'create' ? 'created' : 'rotated'
    log.info(`• invitation ${result.inviteId} ${what} (expires ${result.expiresAt}) — pending until accepted`)
    log.info('')

    // 3. Delivery. The link goes to the reserved file or nowhere.
    if (reserved) {
      const delivered = deliverToLinkFile(reserved, result.link)
      reserved = null
      if (!delivered.ok) {
        log.error(`The invitation ${result.inviteId} IS ${what.toUpperCase()}, but the link could not be written to ${linkFile} (${delivered.code}).`)
        log.error(`The link is lost and was not shown${delivered.removed ? '; the partial file was removed' : ''}. Nothing was retried.`)
        log.error(`Recover with: --apply --rotate --link-file <a new path> (same invitation, new link). Do not re-run without --rotate.`)
        return EXIT_LINK_NOT_DELIVERED
      }
      log.info(`The acceptance link is in ${linkFile} (mode 0600). It is NOT shown here.`)
      log.info('Hand it to the admin on a channel you trust, then delete the file.')
    } else {
      log.info('No link was kept. To deliver it, re-run with --apply --rotate --link-file <path>')
      log.info('(same invitation, new link) — or, if the company already has an active Company Admin,')
      log.info(`they press Resend for ${email} in Settings → Team, which emails a fresh link.`)
    }
    return EXIT.OK
  } finally {
    // Refused or failed before delivery: no link exists for this file.
    if (reserved) discardLinkFile(reserved)
  }
}

runOperatorScript(main, {
  usageText: usage(NAME, SPEC),
  onError: (e) => {
    const refusal = describeRefusal(e)
    log.error(redactCredentials(refusal ? `Refused: ${refusal}` : (e?.message ?? e)))
    return EXIT.REFUSED
  },
})
