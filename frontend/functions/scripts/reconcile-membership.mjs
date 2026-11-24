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
//   F2  a profile that holds a project assignment (`projectIds`) it must not:
//       an active member who is NOT a client or subcontractor (R7), or a
//       profile with no active membership (R8)
//       → remove the field. The Rules ignore it in both cases, so no access
//       changes; it is removed so that it can never be revived (ADR-84)
//
// Everything else is reported and left alone — it needs a human decision:
//   R1  a company with no active company_admin
//   R2  an ACTIVE member whose Auth account is disabled (or missing)
//   R3  members/{uid} says deactivated but users/{uid} is active in that company
//   R4  users/{uid} names a company document that does not exist
//   R5  pending invitations expired more than 30 days ago (derived state;
//       nothing to fix — revoke in the app if you want them gone)
//   R6  invitations stuck in a non-pending, non-terminal status
//   R9  an active client / subcontractor whose assignment is not a clean list
//       of at most 30 unique ids, or names a project that does not exist in
//       their company (fix with scripts/set-member-projects.mjs)

import { parseArgs, usage, configureProject, log, silentLogger, runOperatorScript, releaseOnExit, UsageError, EXIT } from './_cli.mjs'

// Output contract. Default: a human report on stdout. With RECONCILE_JSON=1,
// stdout carries EXACTLY ONE line — the JSON array of findings — and every
// human line goes to stderr, beside anything the runtime itself prints there
// (Node process warnings, SDK diagnostics). A consumer parses stdout whole and
// never has to pick the JSON out of mixed output.
const JSON_MODE = process.env.RECONCILE_JSON === '1'
const say = JSON_MODE ? (...a) => console.error(...a) : log.info

const SPEC = {
  'project':    { required: true, pattern: /^[a-z0-9-]{4,40}$/, help: 'Firebase project id (explicit, always)' },
  'company-id': { pattern: /^[A-Za-z0-9_-]{1,64}$/, help: 'limit to one company (default: all)' },
  'fix':        { flag: true, help: 'apply the unambiguous fixes (F1, F2); default is report only' },
}

async function main() {
  let args
  try { args = parseArgs(process.argv.slice(2), SPEC) } catch (e) { throw new UsageError(e.message) }
  const { emulated } = configureProject(args.project)
  const { getDb, getAdminAuth } = await import('../src/lib/firebaseAdmin.js')
  const { syncDeactivatedAuth } = await import('../src/lib/members.js')
  const { isActiveMemberOf, isActiveAdminOf, isDeactivated, effectiveInviteStatus, toMillis } = await import('../src/lib/membershipState.js')
  const { auditNow, auditInTx, AUDIT } = await import('../src/lib/audit.js')
  const { FieldValue } = await import('../src/lib/firebaseAdmin.js')
  const { isExternalRole, currentAssignment, MAX_PROJECT_ASSIGNMENTS } = await import('../src/lib/validation.js')
  const { missingProjects } = await import('../src/lib/projectAssignments.js')

  const db = getDb(), auth = getAdminAuth()
  releaseOnExit(() => db.terminate())
  const now = () => new Date()
  const fix = !!args.fix
  const findings = []
  const report = (code, msg, meta = {}) => { findings.push({ code, msg, meta }); say(`  ${code}  ${msg}`) }

  say(`${fix ? '[FIX] ' : '[REPORT] '}Project ${args.project}${emulated ? ' (EMULATORS)' : ''}${args['company-id'] ? ` · company ${args['company-id']}` : ' · all companies'}`)

  const companiesSnap = args['company-id']
    ? [await db.collection('companies').doc(args['company-id']).get()].filter(s => s.exists)
    : (await db.collection('companies').get()).docs
  const companyIds = new Set(companiesSnap.map(s => s.id))
  if (args['company-id'] && companyIds.size === 0) { log.error('Company not found.'); return EXIT.REFUSED }

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
      say(ok ? `       → fixed: Auth disabled, refresh tokens revoked` : `       → Auth sync failed again; left pending`)
      if (ok) await auditNow(db, companyId, { type: AUDIT.RECONCILE_FIX, actorUid: 'operator', targetUid: u.uid, after: { fix: 'F1' }, source: 'operator' }, now())
    }
  }

  // R7 / R8 (fix F2), R9 — project assignments (ADR-84)
  for (const u of users) {
    if (u.projectIds === undefined) continue
    const active = isActiveMemberOf(u, u.companyId)
    const companyId = active ? u.companyId : (u.formerCompanyId ?? null)
    if (args['company-id'] && companyId !== args['company-id']) continue
    if (active && isExternalRole(u.role)) {
      const held = currentAssignment(u.projectIds)
      if (!held.sound || held.projectIds.length > MAX_PROJECT_ASSIGNMENTS) {
        report('R9', `users/${u.uid} (${u.role} of ${companyId}) holds a project assignment that is not a list of at most ${MAX_PROJECT_ASSIGNMENTS} unique ids`)
      } else if (companyIds.has(companyId)) {
        const missing = await missingProjects(db, db, companyId, held.projectIds)
        if (missing.length > 0) report('R9', `users/${u.uid} (${u.role} of ${companyId}) is assigned ${missing.length} project(s) that do not exist there: ${missing.join(', ')}`, { missing })
      }
      continue
    }
    const code = active ? 'R7' : 'R8'
    report(code, active
      ? `users/${u.uid} is an active ${u.role ?? '(no role)'} of ${companyId} but holds a project assignment (only a client or subcontractor may)`
      : `users/${u.uid} has no active membership but still holds a project assignment`)
    if (!fix) continue
    if (!companyId || !companyIds.has(companyId)) { say('       → left alone: no company to record the fix under'); continue }
    // Re-read inside a transaction: the profile may have been accepted,
    // deactivated or reassigned since the scan.
    const fixed = await db.runTransaction(async (tx) => {
      const ref = db.collection('users').doc(u.uid)
      const snap = await tx.get(ref)
      const p = snap.exists ? snap.data() : null
      if (!p || p.projectIds === undefined) return false
      if (isActiveMemberOf(p, p.companyId) && isExternalRole(p.role)) return false
      tx.update(ref, { projectIds: FieldValue.delete() })
      auditInTx(tx, db, companyId, {
        type: AUDIT.RECONCILE_FIX, actorUid: 'operator', targetUid: u.uid,
        before: { projectIds: currentAssignment(p.projectIds).projectIds }, after: { fix: 'F2', projectIds: [] }, source: 'operator',
      }, now())
      return true
    })
    say(fixed ? '       → fixed: assignment removed' : '       → changed meanwhile; left alone')
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

  say('')
  say(findings.length === 0 ? 'No inconsistencies found.' : `${findings.length} finding(s). ${fix ? 'Fixes applied where unambiguous.' : 'Re-run with --fix to apply F1 and F2 fixes.'}`)
  if (JSON_MODE) process.stdout.write(`${JSON.stringify(findings)}\n`)
  return EXIT.OK
}

// Never process.exit() here: see runOperatorScript in _cli.mjs. A failed F2
// transaction ends the run (exit 1) after its rollback has been delivered.
runOperatorScript(main, { usageText: usage('scripts/reconcile-membership.mjs', SPEC), out: say })
