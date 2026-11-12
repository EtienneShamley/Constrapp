import { beforeAll, beforeEach, describe, it, expect } from 'vitest'
import {
  admin, resetEmulators, makeHandlers, DAY, seedCompany, seedUser, req, expectTeamError,
  parseLink, sha256, COMPANY_A, COMPANY_B, PROJECT_ID,
} from './_harness.js'

// ── Team-management handlers against the Auth + Firestore emulators ─────────
//
// The handlers are called DIRECTLY with the real Admin SDK (transactions,
// Auth user records, revocation) and an injected mailer + clock. The callable
// transport itself is covered by team.callable.test.js.

let A, H, mailer, now, CODE

beforeAll(async () => { A = await admin(); CODE = A.CODE })

async function fresh(opts = {}) {
  const r = await makeHandlers(opts)
  H = r.handlers; mailer = r.mailer; now = r.now
  return r
}

async function seedCompanyA() {
  await seedCompany(COMPANY_A, 'Acme Builders')
  await seedUser({ uid: 'u_admin', email: 'admin@acme.test', role: 'company_admin', companyId: COMPANY_A, name: 'Ada Admin' })
  await seedUser({ uid: 'u_pm', email: 'pm@acme.test', role: 'project_manager', companyId: COMPANY_A, name: 'Pat PM' })
  await seedUser({ uid: 'u_qs', email: 'qs@acme.test', role: 'qs', companyId: COMPANY_A, name: 'Quin QS' })
}

async function seedCompanyB() {
  await seedCompany(COMPANY_B, 'Other Co')
  await seedUser({ uid: 'u_adminB', email: 'admin@other.test', role: 'company_admin', companyId: COMPANY_B })
}

const invite = async (email = 'new@acme.test', role = 'qs', uid = 'u_admin') => {
  const res = await H.createInvitation(req(uid, { email, role }))
  return { ...res, cred: parseLink(mailer.lastLink()) }
}

const inviteDoc = (companyId, inviteId) => A.db.collection('companies').doc(companyId).collection('invitations').doc(inviteId).get().then(s => s.data())
const userDoc = (uid) => A.db.collection('users').doc(uid).get().then(s => (s.exists ? s.data() : null))
// Audit documents have random ids and a fixed test clock, so read them in a
// deterministic order: by type.
const audits = (companyId) => A.db.collection('companies').doc(companyId).collection('auditEvents').get()
  .then(s => s.docs.map(d => d.data()).sort((a, b) => a.type.localeCompare(b.type)))

beforeEach(async () => {
  await resetEmulators()
  await fresh()
  await seedCompanyA()
})

// ── Authorisation ────────────────────────────────────────────────────────────

describe('caller authorisation', () => {
  it('a signed-in uid with no users/{uid} document is refused (no-membership)', async () => {
    await A.auth.createUser({ uid: 'u_bare', email: 'bare@x.test', password: 'correct-horse-battery' })
    await expectTeamError(H.listTeam(req('u_bare')), CODE.NO_MEMBERSHIP)
    await expectTeamError(H.createInvitation(req('u_bare', { email: 'a@b.test', role: 'qs' })), CODE.NO_MEMBERSHIP)
  })

  it('project_manager and qs are refused as managers; company_admin is allowed', async () => {
    await expectTeamError(H.listTeam(req('u_pm')), CODE.NOT_ADMIN)
    await expectTeamError(H.listTeam(req('u_qs')), CODE.NOT_ADMIN)
    await expectTeamError(H.createInvitation(req('u_pm', { email: 'a@b.test', role: 'qs' })), CODE.NOT_ADMIN)
    await expectTeamError(H.deactivateMember(req('u_qs', { uid: 'u_pm' })), CODE.NOT_ADMIN)
    const team = await H.listTeam(req('u_admin'))
    expect(team.companyId).toBe(COMPANY_A)
  })

  it('super_admin, subcontractor and client callers are refused', async () => {
    await seedUser({ uid: 'u_super', email: 'super@x.test', role: 'super_admin', companyId: COMPANY_A })
    await seedUser({ uid: 'u_sub', email: 'sub@x.test', role: 'subcontractor', companyId: COMPANY_A })
    await seedUser({ uid: 'u_client', email: 'client@x.test', role: 'client', companyId: COMPANY_A })
    for (const uid of ['u_super', 'u_sub', 'u_client']) await expectTeamError(H.listTeam(req(uid)), CODE.NOT_ADMIN)
  })

  it('a deactivated caller is refused (membership-inactive) even if they were an admin', async () => {
    await seedUser({ uid: 'u_admin2', email: 'admin2@acme.test', role: 'company_admin', companyId: COMPANY_A })
    await H.deactivateMember(req('u_admin', { uid: 'u_admin2' }))
    await expectTeamError(H.listTeam(req('u_admin2')), CODE.MEMBERSHIP_INACTIVE)
  })

  it('an admin of another company cannot see or touch this company (tenant isolation)', async () => {
    await seedCompanyB()
    const teamB = await H.listTeam(req('u_adminB'))
    expect(teamB.companyId).toBe(COMPANY_B)
    expect(teamB.members.map(m => m.uid)).toEqual(['u_adminB'])
    await expectTeamError(H.changeMemberRole(req('u_adminB', { uid: 'u_pm', role: 'qs', expectedRole: 'project_manager' })), CODE.NOT_FOUND)
    await expectTeamError(H.deactivateMember(req('u_adminB', { uid: 'u_pm' })), CODE.NOT_FOUND)
    const { inviteId } = await invite()
    await expectTeamError(H.revokeInvitation(req('u_adminB', { inviteId })), CODE.NOT_FOUND)
    await expectTeamError(H.resendInvitation(req('u_adminB', { inviteId })), CODE.NOT_FOUND)
    expect((await userDoc('u_pm')).role).toBe('project_manager')
  })
})

// ── Invitations ──────────────────────────────────────────────────────────────

describe('createInvitation', () => {
  it('stores only the token hash, emails a fragment link, audits, reports delivery', async () => {
    const res = await invite('new@acme.test', 'qs')
    expect(res.delivery).toBe('sent')
    expect(res.link).toBeUndefined()
    const doc = await inviteDoc(COMPANY_A, res.inviteId)
    expect(doc.status).toBe('pending')
    expect(doc.tokenHash).toBe(sha256(res.cred.token))
    expect(JSON.stringify(doc)).not.toContain(res.cred.token)
    expect(doc.sentAt).toBeTruthy()
    expect(doc.sendCount).toBe(1)
    expect(doc.deliveredVia).toBe('email')
    const link = mailer.lastLink()
    expect(link).toMatch(/^http:\/\/localhost:5173\/accept-invite#c=companyA&i=.+&t=.+$/)
    expect(mailer.sent[0].to).toBe('new@acme.test')
    expect(mailer.sent[0].text).toContain('Acme Builders')
    const log = await audits(COMPANY_A)
    expect(log.map(e => e.type)).toEqual(['invite.created'])
    expect(log[0].actorUid).toBe('u_admin')
  })

  it('normalises the email and refuses unsupported roles', async () => {
    const res = await invite('  New.Person@ACME.test ', 'project_manager')
    expect(res.email).toBe('new.person@acme.test')
    for (const role of ['client', 'subcontractor', 'super_admin', 'owner']) {
      await expectTeamError(H.createInvitation(req('u_admin', { email: 'x@acme.test', role })), CODE.INVALID_ROLE)
    }
  })

  it('refuses a duplicate pending invitation and an already-active member', async () => {
    await invite('dup@acme.test')
    await expectTeamError(H.createInvitation(req('u_admin', { email: 'dup@acme.test', role: 'qs' })), CODE.INVITE_PENDING)
    await expectTeamError(H.createInvitation(req('u_admin', { email: 'pm@acme.test', role: 'qs' })), CODE.ALREADY_MEMBER)
  })

  it('keeps the invitation when the email fails, and resend delivers it later', async () => {
    const { EmailError } = await import('../../functions/src/lib/email.js')
    mailer.state.failWith = new EmailError('provider-error', 'Resend responded 500', { status: 500 })
    const res = await H.createInvitation(req('u_admin', { email: 'late@acme.test', role: 'qs' }))
    expect(res.delivery).toBe('failed')
    let doc = await inviteDoc(COMPANY_A, res.inviteId)
    expect(doc.lastSendError).toBe('provider-error')
    expect(doc.sentAt).toBeNull()
    const team = await H.listTeam(req('u_admin'))
    expect(team.invitations[0]).toMatchObject({ email: 'late@acme.test', delivery: 'failed', status: 'pending' })

    mailer.state.failWith = null
    const again = await H.resendInvitation(req('u_admin', { inviteId: res.inviteId }))
    expect(again.delivery).toBe('sent')
    doc = await inviteDoc(COMPANY_A, res.inviteId)
    expect(doc.lastSendError).toBeNull()
    expect(doc.sendCount).toBe(1)
    expect((await audits(COMPANY_A)).map(e => e.type)).toEqual(['invite.created', 'invite.resent'])
  })

  it('refuses when the application URL is not configured, before writing anything', async () => {
    await fresh({ config: { appBaseUrl: '' } })
    await expectTeamError(H.createInvitation(req('u_admin', { email: 'x@acme.test', role: 'qs' })), CODE.APP_URL_NOT_CONFIGURED)
    const snap = await A.db.collection('companies').doc(COMPANY_A).collection('invitations').get()
    expect(snap.empty).toBe(true)
  })

  it('rate-limits an admin to 20 invitations per hour, then allows again after the window', async () => {
    for (let i = 0; i < 20; i += 1) await invite(`p${i}@acme.test`)
    await expectTeamError(H.createInvitation(req('u_admin', { email: 'p20@acme.test', role: 'qs' })), CODE.RATE_LIMITED)
    now.advance(61 * 60 * 1000)
    await invite('p21@acme.test')
  })
})

describe('resend, revoke, expiry, lock', () => {
  it('resend rotates the token: the old link is refused without counting as a guess', async () => {
    const first = await invite()
    const second = await H.resendInvitation(req('u_admin', { inviteId: first.inviteId }))
    const cred2 = parseLink(mailer.lastLink())
    expect(second.inviteId).toBe(first.inviteId)
    expect(cred2.token).not.toBe(first.cred.token)
    await expectTeamError(H.previewInvitation(req(null, first.cred)), CODE.INVALID_INVITATION)
    expect((await inviteDoc(COMPANY_A, first.inviteId)).failedAttempts).toBe(0)
    const preview = await H.previewInvitation(req(null, cred2))
    expect(preview.accountState).toBe('new')
  })

  it('resend is limited to 3 per day per invitation', async () => {
    const { inviteId } = await invite()
    for (let i = 0; i < 3; i += 1) await H.resendInvitation(req('u_admin', { inviteId }))
    await expectTeamError(H.resendInvitation(req('u_admin', { inviteId })), CODE.RATE_LIMITED)
  })

  it('revoke is idempotent and the link then reports revoked to its holder', async () => {
    const { inviteId, cred } = await invite()
    expect(await H.revokeInvitation(req('u_admin', { inviteId }))).toMatchObject({ status: 'revoked', changed: true })
    expect(await H.revokeInvitation(req('u_admin', { inviteId }))).toMatchObject({ status: 'revoked', changed: false })
    await expectTeamError(H.previewInvitation(req(null, cred)), CODE.INVITATION_REVOKED)
    await expectTeamError(H.resendInvitation(req('u_admin', { inviteId })), CODE.INVITATION_REVOKED)
    const team = await H.listTeam(req('u_admin'))
    expect(team.invitations).toEqual([])
  })

  it('expires after seven days; resend restores it', async () => {
    const { inviteId, cred } = await invite()
    now.advance(7 * DAY - 1000)
    expect((await H.previewInvitation(req(null, cred))).accountState).toBe('new')
    now.advance(2000)
    await expectTeamError(H.previewInvitation(req(null, cred)), CODE.INVITATION_EXPIRED)
    expect((await H.listTeam(req('u_admin'))).invitations[0].status).toBe('expired')
    await H.resendInvitation(req('u_admin', { inviteId }))
    expect((await H.previewInvitation(req(null, parseLink(mailer.lastLink())))).accountState).toBe('new')
  })

  it('a wrong token is a generic refusal; ten of them lock the invitation; resend unlocks', async () => {
    const { inviteId, cred } = await invite()
    const wrong = { ...cred, token: 'A'.repeat(43) }
    for (let i = 0; i < 10; i += 1) await expectTeamError(H.previewInvitation(req(null, wrong)), CODE.INVALID_INVITATION)
    expect((await inviteDoc(COMPANY_A, inviteId)).failedAttempts).toBe(10)
    await expectTeamError(H.previewInvitation(req(null, cred)), CODE.INVITATION_LOCKED)
    expect((await H.listTeam(req('u_admin'))).invitations[0].status).toBe('locked')
    await H.resendInvitation(req('u_admin', { inviteId }))
    expect((await H.previewInvitation(req(null, parseLink(mailer.lastLink())))).accountState).toBe('new')
  })

  it('unknown invitation ids and cross-company ids are the same generic refusal and touch no counter', async () => {
    const { cred } = await invite()
    await expectTeamError(H.previewInvitation(req(null, { ...cred, inviteId: 'nope' })), CODE.INVALID_INVITATION)
    await expectTeamError(H.previewInvitation(req(null, { ...cred, companyId: COMPANY_B })), CODE.INVALID_INVITATION)
    const limits = await A.db.collection('companies').doc(COMPANY_B).collection('rateLimits').get()
    expect(limits.empty).toBe(true)
  })

  it('lookups are limited to 30 per hour per invitation', async () => {
    const { cred } = await invite()
    for (let i = 0; i < 30; i += 1) await H.previewInvitation(req(null, cred))
    await expectTeamError(H.previewInvitation(req(null, cred)), CODE.RATE_LIMITED)
  })
})

// ── Preview ──────────────────────────────────────────────────────────────────

describe('previewInvitation account states', () => {
  it('new / existing / already-member / other-company', async () => {
    const n = await invite('nobody@acme.test')
    expect(await H.previewInvitation(req(null, n.cred))).toMatchObject({
      companyName: 'Acme Builders', email: 'nobody@acme.test', role: 'qs', accountState: 'new', inviterName: 'Ada Admin',
    })

    await A.auth.createUser({ uid: 'u_bare', email: 'bare@acme.test', password: 'correct-horse-battery' })
    const e = await invite('bare@acme.test')
    expect((await H.previewInvitation(req(null, e.cred))).accountState).toBe('existing')

    // An active member — created by seeding the profile AFTER the invitation
    // (createInvitation refuses the case up front).
    const m = await invite('member-later@acme.test')
    await seedUser({ uid: 'u_later', email: 'member-later@acme.test', role: 'qs', companyId: COMPANY_A })
    expect((await H.previewInvitation(req(null, m.cred))).accountState).toBe('already-member')

    await seedCompanyB()
    const o = await invite('admin@other.test')
    expect((await H.previewInvitation(req(null, o.cred))).accountState).toBe('other-company')
  })

  it('re-enables a deactivated account (no active membership anywhere) and audits it', async () => {
    await H.deactivateMember(req('u_admin', { uid: 'u_qs' }))
    expect((await A.auth.getUser('u_qs')).disabled).toBe(true)
    const r = await invite('qs@acme.test', 'qs')
    const preview = await H.previewInvitation(req(null, r.cred))
    expect(preview.accountState).toBe('reactivated')
    expect((await A.auth.getUser('u_qs')).disabled).toBe(false)
    expect((await inviteDoc(COMPANY_A, r.inviteId)).reactivatedUid).toBe('u_qs')
    expect((await audits(COMPANY_A)).map(e => e.type)).toContain('member.auth_reenabled')
    // Still no membership: a bare account.
    expect((await userDoc('u_qs')).companyId).toBeNull()
  })

  it('does NOT re-enable a disabled account that still holds a membership elsewhere (blocked)', async () => {
    await seedCompanyB()
    await A.auth.updateUser('u_adminB', { disabled: true })
    const r = await invite('admin@other.test')
    expect((await H.previewInvitation(req(null, r.cred))).accountState).toBe('blocked')
    expect((await A.auth.getUser('u_adminB')).disabled).toBe(true)
  })
})

// ── Accept ───────────────────────────────────────────────────────────────────

describe('acceptInvitation', () => {
  it('a bare Auth account with the invited email becomes a member atomically; the invitation is consumed', async () => {
    const r = await invite('new@acme.test', 'project_manager')
    await A.auth.createUser({ uid: 'u_new', email: 'new@acme.test', password: 'correct-horse-battery', emailVerified: false })
    const res = await H.acceptInvitation(req('u_new', { ...r.cred, name: 'Nia New' }))
    expect(res).toMatchObject({ uid: 'u_new', companyId: COMPANY_A, role: 'project_manager', alreadyAccepted: false })
    const u = await userDoc('u_new')
    expect(u).toMatchObject({ name: 'Nia New', email: 'new@acme.test', role: 'project_manager', companyId: COMPANY_A, status: 'active', inviteId: r.inviteId })
    const m = await A.db.collection('companies').doc(COMPANY_A).collection('members').doc('u_new').get()
    expect(m.data()).toMatchObject({ role: 'project_manager', status: 'active', invitedBy: 'u_admin' })
    const inv = await inviteDoc(COMPANY_A, r.inviteId)
    expect(inv).toMatchObject({ status: 'accepted', acceptedUid: 'u_new' })
    expect((await A.auth.getUser('u_new')).emailVerified).toBe(true)
    expect((await audits(COMPANY_A)).map(e => e.type)).toEqual(['invite.accepted', 'invite.created'])
    const team = await H.listTeam(req('u_admin'))
    expect(team.members.find(x => x.uid === 'u_new')).toMatchObject({ role: 'project_manager', status: 'active', managed: 'team' })
    expect(team.invitations).toEqual([])
  })

  it('does not mark emailVerified for an operator-delivered invitation', async () => {
    const r = await A.invitations.createInvitation(
      (await makeHandlers()).deps, { companyId: COMPANY_A, actor: { uid: 'operator' }, email: 'op@acme.test', role: 'qs', deliveredVia: 'operator', source: 'operator' },
    )
    expect(r.link).toBeTruthy()
    await A.auth.createUser({ uid: 'u_op', email: 'op@acme.test', password: 'correct-horse-battery', emailVerified: false })
    await H.acceptInvitation(req('u_op', parseLink(r.link)))
    expect((await A.auth.getUser('u_op')).emailVerified).toBe(false)
    expect((await userDoc('u_op')).companyId).toBe(COMPANY_A)
  })

  it('the signed-in account must carry the invited email (possession alone is not enough)', async () => {
    const r = await invite('right@acme.test')
    await A.auth.createUser({ uid: 'u_wrong', email: 'wrong@acme.test', password: 'correct-horse-battery' })
    await expectTeamError(H.acceptInvitation(req('u_wrong', r.cred)), CODE.EMAIL_MISMATCH)
    expect(await userDoc('u_wrong')).toBeNull()
    expect((await inviteDoc(COMPANY_A, r.inviteId)).status).toBe('pending')
  })

  it('requires sign-in, a valid token and a live invitation', async () => {
    const r = await invite('x@acme.test')
    await A.auth.createUser({ uid: 'u_x', email: 'x@acme.test', password: 'correct-horse-battery' })
    await expectTeamError(H.acceptInvitation(req(null, r.cred)), CODE.UNAUTHENTICATED)
    await expectTeamError(H.acceptInvitation(req('u_x', { ...r.cred, token: 'B'.repeat(43) })), CODE.INVALID_INVITATION)
    await H.revokeInvitation(req('u_admin', { inviteId: r.inviteId }))
    await expectTeamError(H.acceptInvitation(req('u_x', r.cred)), CODE.INVITATION_REVOKED)
    const r2 = await invite('y@acme.test')
    await A.auth.createUser({ uid: 'u_y', email: 'y@acme.test', password: 'correct-horse-battery' })
    now.advance(8 * DAY)
    await expectTeamError(H.acceptInvitation(req('u_y', r2.cred)), CODE.INVITATION_EXPIRED)
    expect(await userDoc('u_y')).toBeNull()
  })

  it('a member of another company is refused; an existing member of this company is refused', async () => {
    await seedCompanyB()
    const r = await invite('admin@other.test')
    await expectTeamError(H.acceptInvitation(req('u_adminB', r.cred)), CODE.MEMBER_OF_OTHER_COMPANY)
    expect((await userDoc('u_adminB')).companyId).toBe(COMPANY_B)

    const r2 = await invite('later@acme.test')
    await seedUser({ uid: 'u_later', email: 'later@acme.test', role: 'qs', companyId: COMPANY_A })
    await expectTeamError(H.acceptInvitation(req('u_later', r2.cred)), CODE.ALREADY_MEMBER)
    expect((await inviteDoc(COMPANY_A, r2.inviteId)).status).toBe('pending')
  })

  it('a repeat by the same uid is idempotent; a second uid cannot reuse the invitation', async () => {
    const r = await invite('once@acme.test')
    await A.auth.createUser({ uid: 'u_once', email: 'once@acme.test', password: 'correct-horse-battery' })
    const first = await H.acceptInvitation(req('u_once', r.cred))
    const again = await H.acceptInvitation(req('u_once', r.cred))
    expect(first.alreadyAccepted).toBe(false)
    expect(again).toMatchObject({ uid: 'u_once', role: 'qs', alreadyAccepted: true })
    // Another account with the same email cannot exist in Auth, so simulate a
    // forged uid: a different uid presenting the consumed token.
    await A.auth.createUser({ uid: 'u_other', email: 'other@acme.test', password: 'correct-horse-battery' })
    await expectTeamError(H.acceptInvitation(req('u_other', r.cred)), CODE.INVITATION_ACCEPTED)
  })

  it('two concurrent acceptances by the same uid produce one membership and one audit event', async () => {
    const r = await invite('race@acme.test')
    await A.auth.createUser({ uid: 'u_race', email: 'race@acme.test', password: 'correct-horse-battery' })
    const results = await Promise.allSettled([H.acceptInvitation(req('u_race', r.cred)), H.acceptInvitation(req('u_race', r.cred))])
    const ok = results.filter(x => x.status === 'fulfilled')
    expect(ok.length).toBeGreaterThanOrEqual(1)
    for (const x of results.filter(x => x.status === 'rejected')) {
      expect([CODE.INVITATION_BUSY, CODE.INVITATION_ACCEPTED].includes(x.reason?.details?.code) || /transaction|contention|aborted/i.test(x.reason?.message ?? '')).toBe(true)
    }
    expect((await userDoc('u_race')).companyId).toBe(COMPANY_A)
    expect((await audits(COMPANY_A)).filter(e => e.type === 'invite.accepted').length).toBe(1)
  })
})

// ── Members ──────────────────────────────────────────────────────────────────

describe('listTeam', () => {
  it('lists active members (legacy profiles included), operator-managed roles, deactivated history and invitations', async () => {
    await seedUser({ uid: 'u_legacy', email: 'legacy@acme.test', role: 'qs', companyId: COMPANY_A, legacy: true })
    await seedUser({ uid: 'u_client', email: 'client@acme.test', role: 'client', companyId: COMPANY_A })
    await H.deactivateMember(req('u_admin', { uid: 'u_pm' }))
    await invite('pending@acme.test')
    const team = await H.listTeam(req('u_admin'))
    const by = Object.fromEntries(team.members.map(m => [m.uid, m]))
    expect(by.u_admin).toMatchObject({ isSelf: true, status: 'active', managed: 'team', role: 'company_admin' })
    expect(by.u_legacy).toMatchObject({ status: 'active', legacy: true, email: 'legacy@acme.test' })
    expect(by.u_client).toMatchObject({ status: 'active', managed: 'operator' })
    expect(by.u_pm).toMatchObject({ status: 'deactivated', authDisabled: true, authSyncPending: false })
    expect(team.members.findIndex(m => m.uid === 'u_pm')).toBe(team.members.length - 1)
    expect(team.invitations).toHaveLength(1)
    expect(team.invitations[0]).toMatchObject({ email: 'pending@acme.test', status: 'pending', delivery: 'sent' })
    expect(JSON.stringify(team)).not.toContain('tokenHash')
  })
})

describe('changeMemberRole', () => {
  it('changes the role, mirrors it to members, audits, and applies on the next read', async () => {
    const res = await H.changeMemberRole(req('u_admin', { uid: 'u_pm', role: 'qs', expectedRole: 'project_manager' }))
    expect(res).toEqual({ uid: 'u_pm', role: 'qs', changed: true, fileLinksRevocationQueued: false })
    expect((await userDoc('u_pm')).role).toBe('qs')
    const m = await A.db.collection('companies').doc(COMPANY_A).collection('members').doc('u_pm').get()
    expect(m.data().role).toBe('qs')
    expect((await audits(COMPANY_A)).at(-1)).toMatchObject({ type: 'member.role_changed', before: { role: 'project_manager' }, after: { role: 'qs' } })
    // Promotion to company_admin by an admin is allowed (no role above it).
    await H.changeMemberRole(req('u_admin', { uid: 'u_pm', role: 'company_admin', expectedRole: 'qs' }))
    expect((await userDoc('u_pm')).role).toBe('company_admin')
  })

  it('refuses self, stale expectations, operator-managed targets, unknown targets and unsupported roles', async () => {
    await expectTeamError(H.changeMemberRole(req('u_admin', { uid: 'u_admin', role: 'qs', expectedRole: 'company_admin' })), CODE.SELF_TARGET)
    await expectTeamError(H.changeMemberRole(req('u_admin', { uid: 'u_pm', role: 'qs', expectedRole: 'qs' })), CODE.STALE_EXPECTATION)
    await seedUser({ uid: 'u_client', email: 'client@acme.test', role: 'client', companyId: COMPANY_A })
    await expectTeamError(H.changeMemberRole(req('u_admin', { uid: 'u_client', role: 'qs', expectedRole: 'qs' })), CODE.UNSUPPORTED_TARGET)
    await expectTeamError(H.changeMemberRole(req('u_admin', { uid: 'ghost', role: 'qs', expectedRole: 'qs' })), CODE.NOT_FOUND)
    await expectTeamError(H.changeMemberRole(req('u_admin', { uid: 'u_pm', role: 'super_admin', expectedRole: 'project_manager' })), CODE.INVALID_ROLE)
    expect((await userDoc('u_pm')).role).toBe('project_manager')
  })

  it('never demotes the last active company_admin — including when two admins race', async () => {
    await seedUser({ uid: 'u_admin2', email: 'admin2@acme.test', role: 'company_admin', companyId: COMPANY_A })
    // Admin 1 cannot demote themself; admin 2 demoting admin 1 is fine while 2 remains.
    const a = H.changeMemberRole(req('u_admin', { uid: 'u_admin2', role: 'qs', expectedRole: 'company_admin' }))
    const b = H.changeMemberRole(req('u_admin2', { uid: 'u_admin', role: 'qs', expectedRole: 'company_admin' }))
    const results = await Promise.allSettled([a, b])
    const ok = results.filter(r => r.status === 'fulfilled')
    expect(ok).toHaveLength(1)
    const admins = (await A.db.collection('users').where('companyId', '==', COMPANY_A).where('role', '==', 'company_admin').get()).size
    expect(admins).toBe(1)
    const remaining = (await userDoc('u_admin')).role === 'company_admin' ? 'u_admin' : 'u_admin2'
    const other = remaining === 'u_admin' ? 'u_admin2' : 'u_admin'
    // The surviving admin cannot be demoted by anyone now.
    await H.changeMemberRole(req(remaining, { uid: other, role: 'company_admin', expectedRole: 'qs' }))
    await H.changeMemberRole(req(remaining, { uid: other, role: 'qs', expectedRole: 'company_admin' }))
    await expectTeamError(H.changeMemberRole(req(other, { uid: remaining, role: 'qs', expectedRole: 'company_admin' })), CODE.NOT_ADMIN)
  })

  it('a legacy profile without status is treated as active and can be changed', async () => {
    await seedUser({ uid: 'u_legacy', email: 'legacy@acme.test', role: 'qs', companyId: COMPANY_A, legacy: true })
    await H.changeMemberRole(req('u_admin', { uid: 'u_legacy', role: 'project_manager', expectedRole: 'qs' }))
    expect((await userDoc('u_legacy')).role).toBe('project_manager')
  })
})

describe('deactivateMember', () => {
  it('clears the authoritative membership, keeps history, disables Auth and revokes refresh tokens', async () => {
    const before = await A.auth.getUser('u_pm')
    // tokensValidAfterTime has one-second resolution; step past the creation second.
    await new Promise(r => setTimeout(r, 1100))
    const res = await H.deactivateMember(req('u_admin', { uid: 'u_pm' }))
    expect(res).toEqual({ uid: 'u_pm', status: 'deactivated', changed: true, authSynced: true, fileLinks: 'pending' })
    const u = await userDoc('u_pm')
    expect(u).toMatchObject({ companyId: null, role: null, status: 'deactivated', formerCompanyId: COMPANY_A, formerRole: 'project_manager', deactivatedBy: 'u_admin', authSyncPending: false })
    expect(u.name).toBe('Pat PM')
    const after = await A.auth.getUser('u_pm')
    expect(after.disabled).toBe(true)
    expect(after.tokensValidAfterTime).not.toBe(before.tokensValidAfterTime)
    const m = await A.db.collection('companies').doc(COMPANY_A).collection('members').doc('u_pm').get()
    expect(m.data()).toMatchObject({ status: 'deactivated', role: 'project_manager', authSyncPending: false })
    // ADR-74: the same transaction also records the file-link revocation request.
    expect((await audits(COMPANY_A)).map(e => e.type).sort()).toEqual(['file_links.revocation_requested', 'member.auth_synced', 'member.deactivated'])
  })

  it('is idempotent and refuses self, the last admin, operator-managed and foreign targets', async () => {
    await H.deactivateMember(req('u_admin', { uid: 'u_pm' }))
    expect(await H.deactivateMember(req('u_admin', { uid: 'u_pm' }))).toMatchObject({ changed: false, authSynced: true })
    await expectTeamError(H.deactivateMember(req('u_admin', { uid: 'u_admin' })), CODE.SELF_TARGET)
    await seedUser({ uid: 'u_admin2', email: 'admin2@acme.test', role: 'company_admin', companyId: COMPANY_A })
    await H.deactivateMember(req('u_admin2', { uid: 'u_admin' }))
    await expectTeamError(H.deactivateMember(req('u_admin', { uid: 'u_admin2' })), CODE.MEMBERSHIP_INACTIVE)
    await seedUser({ uid: 'u_sub', email: 'sub@acme.test', role: 'subcontractor', companyId: COMPANY_A })
    await expectTeamError(H.deactivateMember(req('u_admin2', { uid: 'u_sub' })), CODE.UNSUPPORTED_TARGET)
    await expectTeamError(H.deactivateMember(req('u_admin2', { uid: 'ghost' })), CODE.NOT_FOUND)
    expect((await userDoc('u_admin2')).role).toBe('company_admin')
  })

  it('two admins deactivating each other at once leaves exactly one active admin', async () => {
    await seedUser({ uid: 'u_admin2', email: 'admin2@acme.test', role: 'company_admin', companyId: COMPANY_A })
    const results = await Promise.allSettled([
      H.deactivateMember(req('u_admin', { uid: 'u_admin2' })),
      H.deactivateMember(req('u_admin2', { uid: 'u_admin' })),
    ])
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.find(r => r.status === 'rejected')
    expect([CODE.LAST_ADMIN, CODE.MEMBERSHIP_INACTIVE]).toContain(rejected.reason?.details?.code)
    const admins = (await A.db.collection('users').where('companyId', '==', COMPANY_A).where('role', '==', 'company_admin').get()).size
    expect(admins).toBe(1)
  })

  it('a failed Auth step leaves a recoverable pending state; a repeat completes it', async () => {
    let fail = true
    const flakyAuth = new Proxy(A.auth, {
      get(target, prop) {
        if (prop === 'updateUser' && fail) return async () => { fail = false; throw new Error('simulated Auth outage') }
        const v = target[prop]
        return typeof v === 'function' ? v.bind(target) : v
      },
    })
    await fresh({ auth: flakyAuth })
    const first = await H.deactivateMember(req('u_admin', { uid: 'u_pm' }))
    expect(first).toMatchObject({ changed: true, authSynced: false })
    expect((await userDoc('u_pm')).authSyncPending).toBe(true)
    expect((await userDoc('u_pm')).companyId).toBeNull()   // Firestore already committed
    expect((await A.auth.getUser('u_pm')).disabled).toBe(false)
    expect((await H.listTeam(req('u_admin'))).members.find(m => m.uid === 'u_pm')).toMatchObject({ status: 'deactivated', authSyncPending: true })
    const second = await H.deactivateMember(req('u_admin', { uid: 'u_pm' }))
    expect(second).toMatchObject({ changed: false, authSynced: true })
    expect((await userDoc('u_pm')).authSyncPending).toBe(false)
    expect((await A.auth.getUser('u_pm')).disabled).toBe(true)
  })

  it('a deactivated member can be re-invited, reactivated and accepted with the SAME uid', async () => {
    await H.deactivateMember(req('u_admin', { uid: 'u_qs' }))
    const r = await invite('qs@acme.test', 'project_manager')
    expect((await H.previewInvitation(req(null, r.cred))).accountState).toBe('reactivated')
    const res = await H.acceptInvitation(req('u_qs', r.cred))
    expect(res).toMatchObject({ uid: 'u_qs', role: 'project_manager', companyId: COMPANY_A })
    const u = await userDoc('u_qs')
    expect(u).toMatchObject({ companyId: COMPANY_A, role: 'project_manager', status: 'active', formerCompanyId: null, deactivatedAt: null })
    expect(u.name).toBe('Quin QS')
    const team = await H.listTeam(req('u_admin'))
    expect(team.members.filter(m => m.uid === 'u_qs')).toHaveLength(1)
    expect(team.members.find(m => m.uid === 'u_qs').status).toBe('active')
  })
})

describe('kill switch', () => {
  it('TEAM_MANAGEMENT_ENABLED=false refuses every call without touching data', async () => {
    await fresh({ config: { enabled: false } })
    await expectTeamError(H.listTeam(req('u_admin')), CODE.DISABLED)
    await expectTeamError(H.createInvitation(req('u_admin', { email: 'x@acme.test', role: 'qs' })), CODE.DISABLED)
    expect((await A.db.collection('companies').doc(COMPANY_A).collection('invitations').get()).empty).toBe(true)
    expect(PROJECT_ID).toBe('constrapp-rules-test')
  })
})
