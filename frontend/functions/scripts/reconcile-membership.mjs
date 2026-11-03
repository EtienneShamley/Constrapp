#!/usr/bin/env node
// ── Operator: reconcile membership state (ADR-72) ────────────────────────────
//
//   node scripts/reconcile-membership.mjs --project <id> [--company-id <id>] [--fix]
//
// Dry-run by default: REPORTS every inconsistency it can detect between the
// authoritative users/{uid} documents, the per-company members/ history, the
// invitations and Firebase Auth. With --fix it applies ONLY the fixes that are
// unambiguous and already the system's own intent:
//
//   F1  users with status=deactivated and authSyncPending=true
//       → disable the Auth account + revoke refresh tokens, clear the flag
//       (exactly what deactivateMember does after its Firestore commit)
//
// Everything else is reported and left alone — it needs a human decision:
//   R1  a company with no active company_admin
//   R2  an ACTIVE member whose Auth account is disabled (or missing)
//   R3  members/{uid} says deactivated but users/{uid} is active in that company
//   R4  users/{uid} names a company document that does not exist
//   R5  pending invitations expired more than 30 days ago (derived state;
//       nothing to fix — revoke in the app if you want them gone)
//   R6  invitations stuck in a non-pending, non-terminal status

import { parseArgs, usage, configureProject, log, silentLogger } from './_cli.mjs'

const SPEC = {
  'project':    { required: true, pattern: /^[a-z0-9-]{4,40}$/, help: 'Firebase project id (explicit, always)' },
  'company-id': { pattern: /^[A-Za-z0-9_-]{1,64}$/, help: 'limit to one company (default: all)' },
  'fix':        { flag: true, help: 'apply the unambiguous fixes (F1); default is report only' },
}

async function main() {
  let args
  try { args = parseArgs(process.argv.slice(2), SPEC) } catch (e) { log.error(e.message); console.log(usage('scripts/reconcile-membership.mjs', SPEC)); process.exit(2) }
  const { emulated } = configureProject(args.project)
  const { getDb, getAdminAuth } = await import('../src/lib/firebaseAdmin.js')
  const { syncDeactivatedAuth } = await import('../src/lib/members.js')
  const { isActiveMemberOf, isActiveAdminOf, isDeactivated, effectiveInviteStatus, toMillis } = await import('../src/lib/membershipState.js')
  const { auditNow, AUDIT } = await import('../src/lib/audit.js')

  const db = getDb(), auth = getAdminAuth()
  const now = () => new Date()
  const fix = !!args.fix
  const findings = []
  const report = (code, msg, meta = {}) => { findings.push({ code, msg, meta }); log.info(`  ${code}  ${msg}`) }

  log.info(`${fix ? '[FIX] ' : '[REPORT] '}Project ${args.project}${emulated ? ' (EMULATORS)' : ''}${args['company-id'] ? ` · company ${args['company-id']}` : ' · all companies'}`)

  const companiesSnap = args['company-id']
    ? [await db.collection('companies').doc(args['company-id']).get()].filter(s => s.exists)
    : (await db.collection('companies').get()).docs
  const companyIds = new Set(companiesSnap.map(s => s.id))
  if (args['company-id'] && companyIds.size === 0) { log.error('Company not found.'); process.exit(1) }

  const usersSnap = await db.collection('users').get()
  const users = usersSnap.docs.map(d => ({ uid: d.id, ...d.data() }))

  // F1 — pending Auth sync after deactivation
  for (const u of users) {
    if (!isDeactivated(u) || u.authSyncPending !== true) continue
    const companyId = u.formerCompanyId
    if (args['company-id'] && companyId !== args['company-id']) continue
    report('F1', `users/${u.uid} deactivated from ${companyId ?? '?'} but Auth sync is pending`)
    if (fix && companyId) {
      const ok = await syncDeactivatedAuth({ db, auth, now, log: silentLogger }, { companyId, uid: u.uid, actorUid: 'operator', source: 'operator' })
      log.info(ok ? `       → fixed: Auth disabled, refresh tokens revoked` : `       → Auth sync failed again; left pending`)
      if (ok) await auditNow(db, companyId, { type: AUDIT.RECONCILE_FIX, actorUid: 'operator', targetUid: u.uid, after: { fix: 'F1' }, source: 'operator' }, now())
    }
  }

  // R4 — dangling company references
  for (const u of users) {
    if (typeof u.companyId === 'string' && u.companyId && !companyIds.has(u.companyId) && !args['company-id']) {
      report('R4', `users/${u.uid} names company ${u.companyId}, which does not exist`)
    }
  }

  for (const c of companiesSnap) {
    const companyId = c.id
    const activeHere = users.filter(u => isActiveMemberOf(u, companyId))

    // R1 — no active admin
    if (!activeHere.some(u => isActiveAdminOf(u, companyId))) report('R1', `company ${companyId} has NO active company_admin`)

    // R2 — active member with disabled/missing Auth
    for (const u of activeHere) {
      try {
        const rec = await auth.getUser(u.uid)
        if (rec.disabled) report('R2', `users/${u.uid} is an active ${u.role} of ${companyId} but the Auth account is DISABLED`)
      } catch (e) {
        if (e?.code === 'auth/user-not-found') report('R2', `users/${u.uid} is an active ${u.role} of ${companyId} but has NO Auth account`)
        else throw e
      }
    }

    // R3 — members history contradicts the authoritative document
    const members = await db.collection('companies').doc(companyId).collection('members').get()
    for (const m of members.docs) {
      const u = users.find(x => x.uid === m.id)
      if (m.data().status === 'deactivated' && u && isActiveMemberOf(u, companyId)) {
        report('R3', `members/${m.id} says deactivated but users/${m.id} is active in ${companyId} (re-invited without members update?)`)
      }
    }

    // R5 / R6 — invitations
    const invites = await db.collection('companies').doc(companyId).collection('invitations').get()
    for (const inv of invites.docs) {
      const d = inv.data()
      const eff = effectiveInviteStatus(d, now())
      if (eff === 'expired' && toMillis(d.expiresAt) < now().getTime() - 30 * 24 * 60 * 60 * 1000) {
        report('R5', `invitation ${companyId}/${inv.id} for ${d.email} expired over 30 days ago (revoke in the app to tidy)`)
      }
      if (!['pending', 'accepted', 'revoked'].includes(d.status)) report('R6', `invitation ${companyId}/${inv.id} has unexpected status "${d.status}"`)
    }
  }

  log.info('')
  log.info(findings.length === 0 ? 'No inconsistencies found.' : `${findings.length} finding(s). ${fix ? 'Fixes applied where unambiguous.' : 'Re-run with --fix to apply F1 fixes.'}`)
  if (process.env.RECONCILE_JSON === '1') console.log(JSON.stringify(findings))
}

main().catch((e) => { log.error(e?.message ?? e); process.exit(1) })
