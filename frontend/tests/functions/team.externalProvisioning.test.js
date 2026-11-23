import { beforeAll, beforeEach, afterEach, afterAll, describe, it, expect } from 'vitest'
import { doc, getDoc, getDocs, collection, updateDoc } from 'firebase/firestore'
import {
  admin, resetEmulators, makeHandlers, seedCompany, seedUser, req, expectTeamError, parseLink,
  clientSdk, clientSignIn, clientSignOutAll, COMPANY_A, COMPANY_B,
} from './_harness.js'

// ── M2-A2 Stage B (ADR-84) — external members: provisioning, assignment, ─────
//    acceptance, deactivation and revocation, against the emulators
//
// The trusted code runs with the real Admin SDK (transactions, Auth). Where a
// test says "the Rules", a signed-in CLIENT SDK reads through the firestore
// .rules the emulator loaded — the same file production publishes — so an
// assignment written here is proven to open exactly what it names.

let A, H, deps, mailer, CODE, MP, INV

beforeAll(async () => {
  A = await admin(); CODE = A.CODE; INV = A.invitations
  MP = await import('../../functions/src/lib/memberProjects.js')
})

const PASSWORD = 'correct-horse-battery'
const company = (id) => A.db.collection('companies').doc(id)
const userDoc = (uid) => A.db.collection('users').doc(uid).get().then(s => (s.exists ? s.data() : null))
const memberDoc = (uid, c = COMPANY_A) => company(c).collection('members').doc(uid).get().then(s => (s.exists ? s.data() : null))
const inviteDoc = (inviteId, c = COMPANY_A) => company(c).collection('invitations').doc(inviteId).get().then(s => (s.exists ? s.data() : null))
const invites = (c = COMPANY_A) => company(c).collection('invitations').get().then(s => s.docs.map(d => ({ id: d.id, ...d.data() })))
const audits = (c = COMPANY_A) => company(c).collection('auditEvents').get().then(s => s.docs.map(d => d.data()))
const auditsOf = async (type, c = COMPANY_A) => (await audits(c)).filter(e => e.type === type)
const stateDoc = (c = COMPANY_A) => company(c).collection('system').doc('fileLinkRevocation').get().then(s => (s.exists ? s.data() : null))
const markerDoc = (c = COMPANY_A) => company(c).collection('fileLinkRevocationQueue').doc('pending').get().then(s => (s.exists ? s.data() : null))
const lockDoc = (c = COMPANY_A) => company(c).collection('system').doc('membership').get().then(s => (s.exists ? s.data() : null))

// A project and its external-safe directory entry, as the application writes them.
async function seedProject(companyId, id, name = `Project ${id}`) {
  const shared = { name, status: 'active', location: 'Site', startDate: null, progress: 0 }
  await company(companyId).collection('projects').doc(id).set({ ...shared, budget: 250000, currency: 'AUD' })
  await company(companyId).collection('projectDirectory').doc(id).set(shared)
}

const provision = async (email, role, projectIds, extra = {}) => {
  const r = await MP.provisionExternalMember(deps, { companyId: COMPANY_A, email, role, projectIds, dryRun: false, ...extra })
  return { ...r, cred: parseLink(r.link) }
}

// Provision, register the Auth account and accept — a complete onboarding.
const onboard = async (uid, email, role, projectIds) => {
  const r = await provision(email, role, projectIds)
  await A.auth.createUser({ uid, email, password: PASSWORD })
  await H.acceptInvitation(req(uid, r.cred))
  return r
}

const setProjects = (uid, change, extra = {}) => MP.setMemberProjects(deps, { companyId: COMPANY_A, uid, change, dryRun: false, ...extra })

const refusedAssignment = async (promise, reason) => {
  const e = await expectTeamError(promise, CODE.INVALID_ASSIGNMENT)
  expect(e.details.reason).toBe(reason)
  return e
}

// The Rules' verdict for the signed-in client.
const canRead = async (ref) => {
  try { await getDoc(ref); return true } catch (e) { if (e?.code === 'permission-denied') return false; throw e }
}
const dirRef = (c, p) => doc(clientSdk().db, 'companies', c, 'projectDirectory', p)
const projRef = (c, p) => doc(clientSdk().db, 'companies', c, 'projects', p)
const drawingRef = (c, p, id) => doc(clientSdk().db, 'companies', c, 'projects', p, 'drawings', id)

beforeEach(async () => {
  await clientSignOutAll()
  await resetEmulators()
  ;({ handlers: H, deps, mailer } = await makeHandlers())
  await seedCompany(COMPANY_A, 'Acme Builders')
  await seedUser({ uid: 'u_admin', email: 'admin@acme.test', role: 'company_admin', companyId: COMPANY_A, name: 'Ada Admin' })
  await seedUser({ uid: 'u_pm', email: 'pm@acme.test', role: 'project_manager', companyId: COMPANY_A, name: 'Pat PM' })
  await seedUser({ uid: 'u_qs', email: 'qs@acme.test', role: 'qs', companyId: COMPANY_A, name: 'Quin QS' })
  for (const p of ['p1', 'p2', 'p3']) await seedProject(COMPANY_A, p)
  await seedCompany(COMPANY_B, 'Other Co')
  await seedUser({ uid: 'u_adminB', email: 'admin@other.test', role: 'company_admin', companyId: COMPANY_B })
  await seedProject(COMPANY_B, 'pB')
})
afterEach(async () => { await clientSignOutAll() })
afterAll(async () => { await clientSignOutAll() })

// ── Provisioning ─────────────────────────────────────────────────────────────

describe('provisionExternalMember', () => {
  it('a dry run checks everything and writes nothing at all', async () => {
    const plan = await MP.provisionExternalMember(deps, { companyId: COMPANY_A, email: ' Cleo@Client.Test ', role: 'client', projectIds: ['p2', 'p1'] })
    expect(plan).toEqual({ companyId: COMPANY_A, companyName: 'Acme Builders', email: 'cleo@client.test', role: 'client', projectIds: ['p1', 'p2'], account: 'new', dryRun: true })
    expect(await invites()).toEqual([])
    expect(await audits()).toEqual([])
    expect(await lockDoc()).toBeNull()
    expect(mailer.sent).toEqual([])
  })

  it('creates ONE pending, operator-delivered invitation carrying the sorted assignment — for a client and for a subcontractor', async () => {
    for (const [email, role, ids] of [['cleo@client.test', 'client', ['p2', 'p1']], ['sam@sub.test', 'subcontractor', ['p3']]]) {
      const r = await provision(email, role, ids)
      const sorted = [...ids].sort()
      expect(r).toMatchObject({ dryRun: false, email, role, projectIds: sorted, account: 'new' })
      const inv = await inviteDoc(r.inviteId)
      expect(inv).toMatchObject({ email, role, projectIds: sorted, status: 'pending', deliveredVia: 'operator', createdBy: 'operator', acceptedUid: null, sendCount: 0 })
      // Only the hash is stored; the raw token exists in the returned link alone.
      expect(inv.tokenHash).toMatch(/^[0-9a-f]{64}$/)
      expect(JSON.stringify(inv)).not.toContain(r.cred.token)
      expect((await H.previewInvitation(req(null, r.cred)))).toMatchObject({ email, role, accountState: 'new' })
    }
    expect(mailer.sent).toEqual([])
    const created = await auditsOf('invite.created')
    expect(created).toHaveLength(2)
    expect(created.every(e => e.actorUid === 'operator' && e.source === 'operator' && e.after.deliveredVia === 'operator')).toBe(true)
    expect(created.map(e => e.after.projectIds).sort()).toEqual([['p1', 'p2'], ['p3']])
    // Provisioning alone gives no membership and no access.
    expect((await A.db.collection('users').get()).size).toBe(4)
  })

  it('refuses every role except client and subcontractor, and writes nothing', async () => {
    for (const role of ['company_admin', 'project_manager', 'qs', 'super_admin', 'owner', '', undefined, null, 'Client']) {
      await expectTeamError(MP.provisionExternalMember(deps, { companyId: COMPANY_A, email: 'x@ext.test', role, projectIds: ['p1'], dryRun: false }), CODE.INVALID_ROLE)
    }
    expect(await invites()).toEqual([])
    expect(await audits()).toEqual([])
  })

  it('refuses a missing, empty, oversized, duplicate, malformed, nonexistent or cross-company assignment', async () => {
    const attempt = (projectIds) => MP.provisionExternalMember(deps, { companyId: COMPANY_A, email: 'x@ext.test', role: 'client', projectIds, dryRun: false })
    await refusedAssignment(attempt(undefined), 'missing')
    await refusedAssignment(attempt(null), 'missing')
    await refusedAssignment(attempt([]), 'empty')
    await refusedAssignment(attempt(Array.from({ length: 31 }, (_, i) => `q${i}`)), 'too-many')
    await refusedAssignment(attempt(['p1', 'p2', 'p1']), 'duplicate')
    for (const bad of ['p1', ['p1', 7], ['a/b'], [''], [['p1']], { 0: 'p1' }]) await refusedAssignment(attempt(bad), 'malformed')
    const gone = await refusedAssignment(attempt(['p1', 'nope']), 'project-not-found')
    expect(gone.details.projectIds).toEqual(['nope'])
    // pB exists — in ANOTHER company. Here it is simply absent.
    const foreign = await refusedAssignment(attempt(['pB', 'p1']), 'project-not-found')
    expect(foreign.details.projectIds).toEqual(['pB'])
    // The dry run refuses the same way.
    await refusedAssignment(MP.provisionExternalMember(deps, { companyId: COMPANY_A, email: 'x@ext.test', role: 'client', projectIds: ['pB'] }), 'project-not-found')
    expect(await invites()).toEqual([])
    expect(await audits()).toEqual([])
  })

  it('refuses an unknown company, an existing member, another company\'s member and a second pending invitation', async () => {
    const base = { email: 'x@ext.test', role: 'client', projectIds: ['p1'], dryRun: false }
    await expectTeamError(MP.provisionExternalMember(deps, { ...base, companyId: 'ghostco' }), CODE.NOT_FOUND)
    await expectTeamError(MP.provisionExternalMember(deps, { ...base, companyId: 'bad id' }), CODE.INVALID_ARGUMENT)
    await expectTeamError(MP.provisionExternalMember(deps, { ...base, companyId: COMPANY_A, email: 'not-an-email' }), CODE.INVALID_ARGUMENT)
    await expectTeamError(MP.provisionExternalMember(deps, { ...base, companyId: COMPANY_A, email: 'qs@acme.test' }), CODE.ALREADY_MEMBER)
    await expectTeamError(MP.provisionExternalMember(deps, { ...base, companyId: COMPANY_A, email: 'admin@other.test' }), CODE.MEMBER_OF_OTHER_COMPANY)
    const first = await provision('x@ext.test', 'client', ['p1'])
    const e = await expectTeamError(MP.provisionExternalMember(deps, { ...base, companyId: COMPANY_A }), CODE.INVITE_PENDING)
    expect(e.details.inviteId).toBe(first.inviteId)
    expect(await invites()).toHaveLength(1)
  })
})

// ── The callable surface is not widened ──────────────────────────────────────

describe('a browser cannot create or shape an external membership', () => {
  it('the invitation callable still refuses external roles and any projectIds key', async () => {
    for (const role of ['client', 'subcontractor', 'super_admin']) await expectTeamError(H.createInvitation(req('u_admin', { email: 'x@ext.test', role })), CODE.INVALID_ROLE)
    await expectTeamError(H.createInvitation(req('u_admin', { email: 'x@ext.test', role: 'qs', projectIds: ['p1'] })), CODE.INVALID_ARGUMENT)
    await expectTeamError(H.createInvitation(req('u_admin', { email: 'x@ext.test', role: 'client', projectIds: ['p1'] })), CODE.INVALID_ARGUMENT)
    expect(await invites()).toEqual([])
  })

  it('the library refuses an external invitation that is not an operator\'s, and an internal one that carries projects', async () => {
    const actor = { uid: 'u_admin', name: 'Ada Admin' }
    const base = { companyId: COMPANY_A, actor, email: 'x@ext.test' }
    // From a callable source — even operator-delivered, even by email.
    await expectTeamError(INV.createInvitation(deps, { ...base, role: 'client', projectIds: ['p1'] }), CODE.INVALID_ROLE)
    await expectTeamError(INV.createInvitation(deps, { ...base, role: 'client', projectIds: ['p1'], deliveredVia: 'operator' }), CODE.INVALID_ROLE)
    await expectTeamError(INV.createInvitation(deps, { ...base, role: 'subcontractor', projectIds: ['p1'], source: 'operator' }), CODE.INVALID_ROLE)
    await refusedAssignment(INV.createInvitation(deps, { ...base, role: 'client', source: 'operator', deliveredVia: 'operator' }), 'missing')
    await refusedAssignment(INV.createInvitation(deps, { ...base, role: 'qs', projectIds: ['p1'] }), 'role')
    await refusedAssignment(INV.createInvitation(deps, { ...base, role: 'company_admin', projectIds: [], source: 'operator', deliveredVia: 'operator' }), 'role')
    await expectTeamError(INV.createInvitation(deps, { ...base, role: 'super_admin', source: 'operator', deliveredVia: 'operator' }), CODE.INVALID_ROLE)
    await refusedAssignment(INV.createInvitation(deps, { ...base, role: 'client', projectIds: ['pB'], source: 'operator', deliveredVia: 'operator' }), 'project-not-found')
    expect(await invites()).toEqual([])
    expect(await audits()).toEqual([])
    expect(mailer.sent).toEqual([])
  })

  it('acceptance refuses client-supplied projectIds or role, and the invitee cannot write their own assignment', async () => {
    const r = await provision('cleo@client.test', 'client', ['p1'])
    await A.auth.createUser({ uid: 'u_cleo', email: 'cleo@client.test', password: PASSWORD })
    await expectTeamError(H.acceptInvitation(req('u_cleo', { ...r.cred, projectIds: ['p1', 'p2', 'p3'] })), CODE.INVALID_ARGUMENT)
    await expectTeamError(H.acceptInvitation(req('u_cleo', { ...r.cred, role: 'company_admin' })), CODE.INVALID_ARGUMENT)
    expect(await userDoc('u_cleo')).toBeNull()
    await H.acceptInvitation(req('u_cleo', r.cred))
    expect((await userDoc('u_cleo')).projectIds).toEqual(['p1'])
    // users/{uid} is client-read-only (ADR-27): the Rules refuse the write.
    await clientSignIn('cleo@client.test')
    await expect(updateDoc(doc(clientSdk().db, 'users', 'u_cleo'), { projectIds: ['p1', 'p2', 'p3'] })).rejects.toMatchObject({ code: 'permission-denied' })
    expect((await userDoc('u_cleo')).projectIds).toEqual(['p1'])
  })
})

// ── Acceptance ───────────────────────────────────────────────────────────────

describe('acceptInvitation — external roles', () => {
  it('the membership, the assignment, the consumed invitation and the audit event are ONE commit', async () => {
    const r = await provision('cleo@client.test', 'client', ['p2', 'p1'])
    await A.auth.createUser({ uid: 'u_cleo', email: 'cleo@client.test', password: PASSWORD, displayName: 'Cleo Client' })
    const res = await H.acceptInvitation(req('u_cleo', r.cred))
    expect(res).toEqual({ uid: 'u_cleo', companyId: COMPANY_A, role: 'client', name: 'Cleo Client', alreadyAccepted: false })
    expect('projectIds' in res).toBe(false)

    const userSnap = await A.db.collection('users').doc('u_cleo').get()
    const inviteSnap = await company(COMPANY_A).collection('invitations').doc(r.inviteId).get()
    expect(userSnap.data()).toMatchObject({ role: 'client', companyId: COMPANY_A, status: 'active', projectIds: ['p1', 'p2'], inviteId: r.inviteId })
    expect(inviteSnap.data()).toMatchObject({ status: 'accepted', acceptedUid: 'u_cleo', projectIds: ['p1', 'p2'] })
    // One transaction: the two documents carry the same commit time.
    expect(userSnap.updateTime.isEqual(inviteSnap.updateTime)).toBe(true)
    // History never carries the assignment — it is not a source of permissions.
    expect('projectIds' in (await memberDoc('u_cleo'))).toBe(false)
    const [accepted] = await auditsOf('invite.accepted')
    expect(accepted).toMatchObject({ actorUid: 'u_cleo', targetUid: 'u_cleo', inviteId: r.inviteId, after: { role: 'client', companyId: COMPANY_A, projectIds: ['p1', 'p2'] } })
    expect('projectIds' in accepted.before).toBe(false)
    // An operator-delivered link proves nothing about the mailbox.
    expect((await A.auth.getUser('u_cleo')).emailVerified).toBe(false)
    // A repeat is the same answer and writes nothing more.
    expect(await H.acceptInvitation(req('u_cleo', r.cred))).toMatchObject({ alreadyAccepted: true, role: 'client' })
    expect(await auditsOf('invite.accepted')).toHaveLength(1)
  })

  it('the Rules open exactly the assigned projects: unassigned, cross-company and the project document itself stay closed', async () => {
    await company(COMPANY_A).collection('projects').doc('p1').collection('drawings').doc('d1').set({ title: 'GA plan' })
    await company(COMPANY_A).collection('projects').doc('p3').collection('drawings').doc('d3').set({ title: 'Section' })
    await onboard('u_cleo', 'cleo@client.test', 'client', ['p1', 'p2'])
    await onboard('u_sam', 'sam@sub.test', 'subcontractor', ['p3'])

    await clientSignIn('cleo@client.test')
    expect((await getDoc(dirRef(COMPANY_A, 'p1'))).data().name).toBe('Project p1')
    expect(await canRead(dirRef(COMPANY_A, 'p2'))).toBe(true)
    expect(await canRead(drawingRef(COMPANY_A, 'p1', 'd1'))).toBe(true)
    expect(await canRead(dirRef(COMPANY_A, 'p3'))).toBe(false)          // not assigned
    expect(await canRead(drawingRef(COMPANY_A, 'p3', 'd3'))).toBe(false) // a record of an unassigned project
    expect(await canRead(projRef(COMPANY_A, 'p1'))).toBe(false)         // internal-only: holds the budget
    expect(await canRead(dirRef(COMPANY_B, 'pB'))).toBe(false)          // another company
    await expect(getDocs(collection(clientSdk().db, 'companies', COMPANY_A, 'projectDirectory'))).rejects.toMatchObject({ code: 'permission-denied' })
    await expect(getDocs(collection(clientSdk().db, 'companies', COMPANY_A, 'projects'))).rejects.toMatchObject({ code: 'permission-denied' })

    await clientSignOutAll()
    await clientSignIn('sam@sub.test')
    expect(await canRead(dirRef(COMPANY_A, 'p3'))).toBe(true)
    expect(await canRead(drawingRef(COMPANY_A, 'p3', 'd3'))).toBe(true)
    expect(await canRead(dirRef(COMPANY_A, 'p1'))).toBe(false)
    expect(await canRead(drawingRef(COMPANY_A, 'p1', 'd1'))).toBe(false)
  })

  it('every project is checked AGAIN at acceptance: one removed since provisioning refuses the invitation and writes nothing', async () => {
    const r = await provision('cleo@client.test', 'client', ['p1', 'p2'])
    await A.auth.createUser({ uid: 'u_cleo', email: 'cleo@client.test', password: PASSWORD })
    await company(COMPANY_A).collection('projects').doc('p2').delete()
    const before = await audits()
    const e = await expectTeamError(H.acceptInvitation(req('u_cleo', r.cred)), CODE.INVALID_INVITATION)
    expect(e.details).toEqual({ code: 'invalid-invitation', reason: 'assignment' })
    expect(await userDoc('u_cleo')).toBeNull()
    expect(await memberDoc('u_cleo')).toBeNull()
    expect(await inviteDoc(r.inviteId)).toMatchObject({ status: 'pending', acceptedUid: null, failedAttempts: 0 })
    expect(await audits()).toHaveLength(before.length)
    // Once the project exists again the SAME invitation is accepted.
    await seedProject(COMPANY_A, 'p2')
    await H.acceptInvitation(req('u_cleo', r.cred))
    expect((await userDoc('u_cleo')).projectIds).toEqual(['p1', 'p2'])
  })

  it('a stored invitation that is not sound is refused whatever it says: bad list, unknown role, internal role with projects', async () => {
    const r = await provision('cleo@client.test', 'client', ['p1'])
    await A.auth.createUser({ uid: 'u_cleo', email: 'cleo@client.test', password: PASSWORD })
    const ref = company(COMPANY_A).collection('invitations').doc(r.inviteId)
    const tampered = [
      { projectIds: ['p1', 'p1'] }, { projectIds: [] }, { projectIds: 'p1' }, { projectIds: null }, { projectIds: A.FieldValue.delete() },
      { projectIds: ['p1', 7] }, { projectIds: Array.from({ length: 31 }, (_, i) => `q${i}`) }, { projectIds: ['pB'] },
      { role: 'super_admin' }, { role: 'owner' }, { role: null }, { role: A.FieldValue.delete() },
      { role: 'company_admin' }, { role: 'qs' },                       // internal role still carrying ['p1']
      { role: 'super_admin', projectIds: A.FieldValue.delete() },
    ]
    for (const change of tampered) {
      await ref.update({ role: 'client', projectIds: ['p1'] })
      await ref.update(change)
      await expectTeamError(H.acceptInvitation(req('u_cleo', r.cred)), CODE.INVALID_INVITATION)
      expect(await userDoc('u_cleo'), JSON.stringify(change)).toBeNull()
    }
    expect((await inviteDoc(r.inviteId)).status).toBe('pending')
    expect(await auditsOf('invite.accepted')).toEqual([])
  })

  it('a Company Admin may RESEND an operator invitation: the email goes to the invited address, role and projects are untouched', async () => {
    const r = await provision('cleo@client.test', 'client', ['p1', 'p3'])
    const resent = await H.resendInvitation(req('u_admin', { inviteId: r.inviteId }))
    expect(resent).toMatchObject({ inviteId: r.inviteId, email: 'cleo@client.test', role: 'client', delivery: 'sent' })
    expect(mailer.sent).toHaveLength(1)
    expect(mailer.sent[0].to).toBe('cleo@client.test')
    expect(mailer.sent[0].text).toContain('as Client.')
    expect(await inviteDoc(r.inviteId)).toMatchObject({ role: 'client', projectIds: ['p1', 'p3'], deliveredVia: 'email', status: 'pending' })
    // The operator's link is dead; the emailed one works and proves the mailbox.
    await A.auth.createUser({ uid: 'u_cleo', email: 'cleo@client.test', password: PASSWORD })
    await expectTeamError(H.acceptInvitation(req('u_cleo', r.cred)), CODE.INVALID_INVITATION)
    await H.acceptInvitation(req('u_cleo', parseLink(mailer.lastLink())))
    expect(await userDoc('u_cleo')).toMatchObject({ role: 'client', projectIds: ['p1', 'p3'] })
    expect((await A.auth.getUser('u_cleo')).emailVerified).toBe(true)
    // A revoked external invitation is refused like any other.
    const second = await provision('sam@sub.test', 'subcontractor', ['p2'])
    await H.revokeInvitation(req('u_admin', { inviteId: second.inviteId }))
    await A.auth.createUser({ uid: 'u_sam', email: 'sam@sub.test', password: PASSWORD })
    await expectTeamError(H.acceptInvitation(req('u_sam', second.cred)), CODE.INVITATION_REVOKED)
    expect(await userDoc('u_sam')).toBeNull()
  })

  it('the signed-in account must still be the invited email, and a second account cannot reuse the invitation', async () => {
    const r = await provision('cleo@client.test', 'client', ['p1'])
    await A.auth.createUser({ uid: 'u_other', email: 'other@client.test', password: PASSWORD })
    await expectTeamError(H.acceptInvitation(req('u_other', r.cred)), CODE.EMAIL_MISMATCH)
    await expectTeamError(H.acceptInvitation(req(null, r.cred)), CODE.UNAUTHENTICATED)
    expect(await userDoc('u_other')).toBeNull()
    await A.auth.createUser({ uid: 'u_cleo', email: 'cleo@client.test', password: PASSWORD })
    await H.acceptInvitation(req('u_cleo', r.cred))
    await expectTeamError(H.acceptInvitation(req('u_other', r.cred)), CODE.INVITATION_ACCEPTED)
  })
})

// ── Internal roles: unchanged, and never holding an assignment ───────────────

describe('internal invitations are unchanged', () => {
  it('an internal invitation and the membership it creates carry no projectIds key at all', async () => {
    const res = await H.createInvitation(req('u_admin', { email: 'new@acme.test', role: 'project_manager' }))
    expect(res).toEqual({ inviteId: res.inviteId, email: 'new@acme.test', role: 'project_manager', expiresAt: res.expiresAt, delivery: 'sent' })
    expect('projectIds' in (await inviteDoc(res.inviteId))).toBe(false)
    const [created] = await auditsOf('invite.created')
    expect(created.after).toEqual({ role: 'project_manager', expiresAt: res.expiresAt, deliveredVia: 'email' })
    await A.auth.createUser({ uid: 'u_new', email: 'new@acme.test', password: PASSWORD })
    await H.acceptInvitation(req('u_new', parseLink(mailer.lastLink())))
    const profile = await userDoc('u_new')
    expect(profile).toMatchObject({ role: 'project_manager', companyId: COMPANY_A, status: 'active' })
    expect('projectIds' in profile).toBe(false)
    const [accepted] = await auditsOf('invite.accepted')
    expect(accepted.before).toEqual({ status: null, companyId: null })
    expect(accepted.after).toEqual({ role: 'project_manager', companyId: COMPANY_A })
    // Internal members read every project, as before.
    await clientSignIn('new@acme.test')
    expect((await getDocs(collection(clientSdk().db, 'companies', COMPANY_A, 'projects'))).size).toBe(3)
  })

  it('deactivating an internal member writes the same audit shape as before', async () => {
    await H.deactivateMember(req('u_admin', { uid: 'u_qs' }))
    const [e] = await auditsOf('member.deactivated')
    expect(e.before).toEqual({ role: 'qs', companyId: COMPANY_A })
    expect(e.after).toEqual({ role: null, companyId: null, status: 'deactivated' })
    expect('projectIds' in (await userDoc('u_qs'))).toBe(false)
  })
})

// ── Deactivation and re-invitation ───────────────────────────────────────────

describe('an assignment ends with the membership and never comes back', () => {
  it('deactivation removes projectIds in the same commit, records what it was, and the Rules deny at once', async () => {
    await onboard('u_cleo', 'cleo@client.test', 'client', ['p1', 'p2'])
    await clientSignIn('cleo@client.test')
    expect(await canRead(dirRef(COMPANY_A, 'p1'))).toBe(true)

    const res = await H.deactivateMember(req('u_admin', { uid: 'u_cleo' }))
    expect(res).toEqual({ uid: 'u_cleo', status: 'deactivated', changed: true, authSynced: true, fileLinks: 'pending' })
    const profile = await userDoc('u_cleo')
    expect(profile).toMatchObject({ companyId: null, role: null, status: 'deactivated', formerCompanyId: COMPANY_A, formerRole: 'client' })
    expect('projectIds' in profile).toBe(false)
    const [e] = await auditsOf('member.deactivated')
    expect(e.before).toEqual({ role: 'client', companyId: COMPANY_A, projectIds: ['p1', 'p2'] })
    expect(e.after).toEqual({ role: null, companyId: null, status: 'deactivated', projectIds: [] })
    // The existing behaviour is intact: Auth disabled, refresh tokens revoked, sweep queued.
    expect((await A.auth.getUser('u_cleo')).disabled).toBe(true)
    expect(await stateDoc()).toMatchObject({ requestSeq: 1, requestReason: 'member.deactivated', requestPriority: 'urgent' })
    expect(await memberDoc('u_cleo')).toMatchObject({ status: 'deactivated', fileLinkRevocationSeq: 1 })
    // The still-signed-in client is refused on its next request.
    expect(await canRead(dirRef(COMPANY_A, 'p1'))).toBe(false)
    expect(await canRead(dirRef(COMPANY_A, 'p2'))).toBe(false)

    // Repeating the request changes nothing and brings nothing back.
    expect(await H.deactivateMember(req('u_admin', { uid: 'u_cleo' }))).toMatchObject({ changed: false })
    expect('projectIds' in (await userDoc('u_cleo'))).toBe(false)
    expect(await auditsOf('member.deactivated')).toHaveLength(1)
    // And a deactivated member cannot be assigned anything.
    await expectTeamError(setProjects('u_cleo', { set: ['p1'] }), CODE.NOT_FOUND)
    expect('projectIds' in (await userDoc('u_cleo'))).toBe(false)
  })

  it('a re-invited external member gets exactly the NEW invitation\'s projects — the old ones do not revive', async () => {
    await onboard('u_cleo', 'cleo@client.test', 'client', ['p1', 'p2'])
    await H.deactivateMember(req('u_admin', { uid: 'u_cleo' }))
    const again = await provision('cleo@client.test', 'subcontractor', ['p3'])
    expect(again.account).toBe('disabled')
    expect((await H.previewInvitation(req(null, again.cred))).accountState).toBe('reactivated')
    await H.acceptInvitation(req('u_cleo', again.cred))
    expect(await userDoc('u_cleo')).toMatchObject({ role: 'subcontractor', companyId: COMPANY_A, status: 'active', projectIds: ['p3'] })
    await clientSignIn('cleo@client.test')
    expect(await canRead(dirRef(COMPANY_A, 'p3'))).toBe(true)
    expect(await canRead(dirRef(COMPANY_A, 'p1'))).toBe(false)
    expect(await canRead(dirRef(COMPANY_A, 'p2'))).toBe(false)
  })

  it('a former external member re-invited to an INTERNAL role holds no assignment', async () => {
    await onboard('u_cleo', 'cleo@client.test', 'client', ['p1'])
    await H.deactivateMember(req('u_admin', { uid: 'u_cleo' }))
    await H.createInvitation(req('u_admin', { email: 'cleo@client.test', role: 'qs' }))
    const cred = parseLink(mailer.lastLink())
    await H.previewInvitation(req(null, cred))
    await H.acceptInvitation(req('u_cleo', cred))
    const profile = await userDoc('u_cleo')
    expect(profile).toMatchObject({ role: 'qs', companyId: COMPANY_A, status: 'active' })
    expect('projectIds' in profile).toBe(false)
  })

  it('a STALE assignment left on a profile is removed by acceptance — internal role and external role alike — and recorded', async () => {
    // As an older build, a console edit or an interrupted change might leave it.
    for (const [uid, email] of [['u_old1', 'old1@ext.test'], ['u_old2', 'old2@ext.test']]) {
      await A.auth.createUser({ uid, email, password: PASSWORD })
      await A.db.collection('users').doc(uid).set({
        name: uid, email, role: null, companyId: null, status: 'deactivated', formerCompanyId: COMPANY_A, formerRole: 'client',
        projectIds: ['p1', 'p2', 'p3'],
      })
    }
    await H.createInvitation(req('u_admin', { email: 'old1@ext.test', role: 'project_manager' }))
    await H.acceptInvitation(req('u_old1', parseLink(mailer.lastLink())))
    const internal = await userDoc('u_old1')
    expect(internal).toMatchObject({ role: 'project_manager', status: 'active' })
    expect('projectIds' in internal).toBe(false)

    const r = await provision('old2@ext.test', 'client', ['p2'])
    await H.acceptInvitation(req('u_old2', r.cred))
    expect((await userDoc('u_old2')).projectIds).toEqual(['p2'])

    const accepted = await auditsOf('invite.accepted')
    const of = (uid) => accepted.find(e => e.targetUid === uid)
    expect(of('u_old1').before.projectIds).toEqual(['p1', 'p2', 'p3'])
    expect(of('u_old1').after).toEqual({ role: 'project_manager', companyId: COMPANY_A, projectIds: [] })
    expect(of('u_old2').before.projectIds).toEqual(['p1', 'p2', 'p3'])
    expect(of('u_old2').after.projectIds).toEqual(['p2'])
    await clientSignIn('old2@ext.test')
    expect(await canRead(dirRef(COMPANY_A, 'p2'))).toBe(true)
    expect(await canRead(dirRef(COMPANY_A, 'p1'))).toBe(false)
  })
})

// ── Operator assignment changes ──────────────────────────────────────────────

describe('setMemberProjects', () => {
  beforeEach(async () => { await onboard('u_cleo', 'cleo@client.test', 'client', ['p1', 'p2']) })

  it('a dry run returns the change and writes nothing', async () => {
    const lockBefore = await lockDoc()
    const auditsBefore = (await audits()).length
    const plan = await MP.setMemberProjects(deps, { companyId: COMPANY_A, uid: 'u_cleo', change: { add: ['p3'], remove: ['p1'] } })
    expect(plan).toEqual({
      uid: 'u_cleo', companyId: COMPANY_A, email: 'cleo@client.test', role: 'client',
      before: ['p1', 'p2'], after: ['p2', 'p3'], added: ['p3'], removed: ['p1'], changed: true, revocation: true,
      dryRun: true, fileLinkRevocationSeq: null,
    })
    expect((await userDoc('u_cleo')).projectIds).toEqual(['p1', 'p2'])
    expect(await lockDoc()).toEqual(lockBefore)
    expect(await audits()).toHaveLength(auditsBefore)
    expect(await stateDoc()).toBeNull()
    // The dry run refuses exactly what an apply would.
    await refusedAssignment(MP.setMemberProjects(deps, { companyId: COMPANY_A, uid: 'u_cleo', change: { add: ['pB'] } }), 'project-not-found')
    await refusedAssignment(MP.setMemberProjects(deps, { companyId: COMPANY_A, uid: 'u_qs', change: { add: ['p1'] } }), 'role')
  })

  it('adding a project opens it at once, audits the full list before and after, and queues no revocation', async () => {
    await clientSignIn('cleo@client.test')
    expect(await canRead(dirRef(COMPANY_A, 'p3'))).toBe(false)
    const r = await setProjects('u_cleo', { add: ['p3'] })
    expect(r).toMatchObject({ changed: true, before: ['p1', 'p2'], after: ['p1', 'p2', 'p3'], added: ['p3'], removed: [], revocation: false, fileLinkRevocationSeq: null, dryRun: false })
    expect(await userDoc('u_cleo')).toMatchObject({ projectIds: ['p1', 'p2', 'p3'], updatedBy: 'operator', role: 'client', companyId: COMPANY_A, status: 'active' })
    expect(await canRead(dirRef(COMPANY_A, 'p3'))).toBe(true)
    const [e] = await auditsOf('member.projects_changed')
    expect(e).toMatchObject({
      actorUid: 'operator', source: 'operator', targetUid: 'u_cleo', targetEmail: 'cleo@client.test',
      before: { projectIds: ['p1', 'p2'] }, after: { projectIds: ['p1', 'p2', 'p3'] },
    })
    expect(await stateDoc()).toBeNull()
    expect(await markerDoc()).toBeNull()
    expect('fileLinkRevocationSeq' in (await memberDoc('u_cleo'))).toBe(false)
  })

  it('removing a project closes it at once and queues an urgent file-link revocation in the same commit', async () => {
    await clientSignIn('cleo@client.test')
    expect(await canRead(dirRef(COMPANY_A, 'p2'))).toBe(true)
    const r = await setProjects('u_cleo', { remove: ['p2'] })
    expect(r).toMatchObject({ changed: true, before: ['p1', 'p2'], after: ['p1'], added: [], removed: ['p2'], revocation: true, fileLinkRevocationSeq: 1 })
    expect((await userDoc('u_cleo')).projectIds).toEqual(['p1'])
    // The Rules re-read users/{uid} on every request.
    expect(await canRead(dirRef(COMPANY_A, 'p2'))).toBe(false)
    expect(await canRead(dirRef(COMPANY_A, 'p1'))).toBe(true)

    expect(await stateDoc()).toMatchObject({ requestSeq: 1, requestReason: 'member.assignment_removed', requestPriority: 'urgent', requestedBy: 'operator', completedSeq: 0 })
    expect(await markerDoc()).toMatchObject({ companyId: COMPANY_A, requestSeq: 1, priority: 'urgent' })
    const member = await memberDoc('u_cleo')
    expect(member).toMatchObject({ status: 'active', role: 'client', fileLinkRevocationSeq: 1 })
    expect(member.fileAccessReducedAt).toBeTruthy()
    const [requested] = await auditsOf('file_links.revocation_requested')
    expect(requested).toMatchObject({ actorUid: 'operator', source: 'operator', targetUid: 'u_cleo', after: { seq: 1, reason: 'member.assignment_removed' } })
    const [changed] = await auditsOf('member.projects_changed')
    expect(changed).toMatchObject({ before: { projectIds: ['p1', 'p2'] }, after: { projectIds: ['p1'] } })
    // The Team page reports old links as PENDING — not revoked — until a sweep finishes.
    const row = (await H.listTeam(req('u_admin'))).members.find(m => m.uid === 'u_cleo')
    expect(row).toMatchObject({ status: 'active', role: 'client', managed: 'operator' })
    expect(row.fileLinks).toMatchObject({ status: 'pending' })
  })

  it('a repeated request is safe: no second write, audit event or revocation request', async () => {
    await setProjects('u_cleo', { remove: ['p2'] })
    const snapshot = async () => ({ audits: (await audits()).length, state: await stateDoc(), profile: await userDoc('u_cleo') })
    const before = await snapshot()
    for (const change of [{ remove: ['p2'] }, { set: ['p1'] }, { add: ['p1'] }, { add: ['p1'], remove: ['p2', 'p3'] }]) {
      expect(await setProjects('u_cleo', change)).toMatchObject({ changed: false, before: ['p1'], after: ['p1'], added: [], removed: [], fileLinkRevocationSeq: null })
    }
    expect(await snapshot()).toEqual(before)
  })

  it('set replaces the list, and an empty set leaves an active member who reads nothing', async () => {
    expect(await setProjects('u_cleo', { set: ['p3'] })).toMatchObject({ after: ['p3'], added: ['p3'], removed: ['p1', 'p2'], fileLinkRevocationSeq: 1 })
    expect(await setProjects('u_cleo', { set: [] })).toMatchObject({ after: [], removed: ['p3'], fileLinkRevocationSeq: 2 })
    expect(await userDoc('u_cleo')).toMatchObject({ projectIds: [], role: 'client', companyId: COMPANY_A, status: 'active' })
    await clientSignIn('cleo@client.test')
    for (const p of ['p1', 'p2', 'p3']) expect(await canRead(dirRef(COMPANY_A, p))).toBe(false)
    expect((await auditsOf('member.projects_changed')).map(e => e.after.projectIds.length).sort()).toEqual([0, 1])
  })

  it('refuses internal, operator-only, deactivated, foreign and unknown members', async () => {
    await refusedAssignment(setProjects('u_qs', { set: ['p1'] }), 'role')
    await refusedAssignment(setProjects('u_pm', { add: ['p1'] }), 'role')
    await refusedAssignment(setProjects('u_admin', { add: ['p1'] }), 'role')
    await seedUser({ uid: 'u_super', email: 'super@acme.test', role: 'super_admin', companyId: COMPANY_A })
    await seedUser({ uid: 'u_odd', email: 'odd@acme.test', role: 'owner', companyId: COMPANY_A })
    await refusedAssignment(setProjects('u_super', { add: ['p1'] }), 'role')
    await refusedAssignment(setProjects('u_odd', { add: ['p1'] }), 'role')
    await expectTeamError(setProjects('u_nobody', { add: ['p1'] }), CODE.NOT_FOUND)
    await expectTeamError(setProjects('bad uid', { add: ['p1'] }), CODE.INVALID_ARGUMENT)
    // Another company's member, and this company's member named under another company.
    await seedUser({ uid: 'u_subB', email: 'sub@other.test', role: 'subcontractor', companyId: COMPANY_B })
    await expectTeamError(setProjects('u_subB', { add: ['p1'] }), CODE.NOT_FOUND)
    await expectTeamError(MP.setMemberProjects(deps, { companyId: COMPANY_B, uid: 'u_cleo', change: { add: ['pB'] }, dryRun: false }), CODE.NOT_FOUND)
    await expectTeamError(MP.setMemberProjects(deps, { companyId: 'ghostco', uid: 'u_cleo', change: { add: ['p1'] }, dryRun: false }), CODE.NOT_FOUND)
    for (const uid of ['u_qs', 'u_pm', 'u_admin', 'u_super', 'u_odd', 'u_subB']) expect('projectIds' in (await userDoc(uid)), uid).toBe(false)
    expect((await userDoc('u_cleo')).projectIds).toEqual(['p1', 'p2'])
    expect(await auditsOf('member.projects_changed')).toEqual([])
    expect(await audits(COMPANY_B)).toEqual([])
  })

  it('refuses a nonexistent or cross-company project, an over-full list and a malformed request — the list is unchanged', async () => {
    const gone = await refusedAssignment(setProjects('u_cleo', { add: ['nope'] }), 'project-not-found')
    expect(gone.details.projectIds).toEqual(['nope'])
    await refusedAssignment(setProjects('u_cleo', { set: ['p1', 'pB'] }), 'project-not-found')
    await refusedAssignment(setProjects('u_cleo', { set: ['p1', 'p1'] }), 'duplicate')
    await refusedAssignment(setProjects('u_cleo', { add: ['p3'], remove: ['p3'] }), 'add-remove-conflict')
    await refusedAssignment(setProjects('u_cleo', { set: ['p1'], add: ['p3'] }), 'malformed')
    await refusedAssignment(setProjects('u_cleo', {}), 'malformed')
    await refusedAssignment(setProjects('u_cleo', { add: [] }), 'empty')
    await refusedAssignment(setProjects('u_cleo', { add: ['a/b'] }), 'malformed')
    // 28 more real projects make 30; a 31st is refused.
    const extra = Array.from({ length: 29 }, (_, i) => `x${String(i).padStart(2, '0')}`)
    for (const id of extra) await company(COMPANY_A).collection('projects').doc(id).set({ name: id })
    expect((await setProjects('u_cleo', { add: extra.slice(0, 28) })).after).toHaveLength(30)
    await refusedAssignment(setProjects('u_cleo', { add: [extra[28]] }), 'too-many')
    expect((await userDoc('u_cleo')).projectIds).toHaveLength(30)
    // An assignment that has come to name a removed project blocks every change that would keep it.
    await company(COMPANY_A).collection('projects').doc('x00').delete()
    const stale = await refusedAssignment(setProjects('u_cleo', { remove: ['p1'] }), 'project-not-found')
    expect(stale.details.projectIds).toEqual(['x00'])
    expect((await setProjects('u_cleo', { remove: ['p1', 'x00'] })).after).toHaveLength(28)
  })

  it('a stored value that is not a clean list is replaced by one', async () => {
    await A.db.collection('users').doc('u_cleo').update({ projectIds: 'p1' })
    expect(await MP.setMemberProjects(deps, { companyId: COMPANY_A, uid: 'u_cleo', change: { set: [] } })).toMatchObject({ before: [], after: [], changed: true })
    expect(await setProjects('u_cleo', { set: [] })).toMatchObject({ changed: true, revocation: false })
    expect((await userDoc('u_cleo')).projectIds).toEqual([])
    await A.db.collection('users').doc('u_cleo').update({ projectIds: ['p2', 'p1', 'p2', 7] })
    expect(await setProjects('u_cleo', { add: ['p3'] })).toMatchObject({ before: ['p1', 'p2'], after: ['p1', 'p2', 'p3'], changed: true })
    expect((await userDoc('u_cleo')).projectIds).toEqual(['p1', 'p2', 'p3'])
  })

  it('concurrent changes serialise: neither is lost, and each audit event starts where the other ended', async () => {
    for (const id of ['c1', 'c2', 'c3', 'c4']) await seedProject(COMPANY_A, id)
    const results = await Promise.all([
      setProjects('u_cleo', { add: ['c1'] }), setProjects('u_cleo', { add: ['c2'] }),
      setProjects('u_cleo', { add: ['c3'] }), setProjects('u_cleo', { remove: ['p1'] }),
    ])
    expect(results.every(r => r.changed)).toBe(true)
    expect((await userDoc('u_cleo')).projectIds).toEqual(['c1', 'c2', 'c3', 'p2'])
    const events = await auditsOf('member.projects_changed')
    expect(events).toHaveLength(4)
    // A chain: from the starting list, each event's `before` is another's `after`.
    const key = (l) => l.join(',')
    let at = key(['p1', 'p2'])
    for (let i = 0; i < 4; i += 1) {
      const next = events.find(e => key(e.before.projectIds) === at && !e.used)
      expect(next, `no event continues from ${at}`).toBeTruthy()
      next.used = true
      at = key(next.after.projectIds)
    }
    expect(at).toBe(key(['c1', 'c2', 'c3', 'p2']))
    // Exactly one removal → exactly one revocation request.
    expect((await stateDoc()).requestSeq).toBe(1)
    expect(await auditsOf('file_links.revocation_requested')).toHaveLength(1)
  })

  it('an assignment change racing a deactivation never leaves an assignment on a removed member', async () => {
    const [assigned, removed] = await Promise.allSettled([
      setProjects('u_cleo', { add: ['p3'] }),
      H.deactivateMember(req('u_admin', { uid: 'u_cleo' })),
    ])
    expect(removed.status).toBe('fulfilled')
    // The change either committed first, or found the member already gone.
    if (assigned.status === 'rejected') expect(assigned.reason.details.code).toBe(CODE.NOT_FOUND)
    const profile = await userDoc('u_cleo')
    expect(profile).toMatchObject({ companyId: null, role: null, status: 'deactivated' })
    expect('projectIds' in profile).toBe(false)
    const [e] = await auditsOf('member.deactivated')
    expect(e.before.projectIds).toEqual(assigned.status === 'fulfilled' ? ['p1', 'p2', 'p3'] : ['p1', 'p2'])
  })

  it('finds the active member by email, and refuses anything else', async () => {
    expect(await MP.findActiveMemberUid(A.db, COMPANY_A, ' Cleo@Client.Test ')).toBe('u_cleo')
    await expectTeamError(MP.findActiveMemberUid(A.db, COMPANY_B, 'cleo@client.test'), CODE.NOT_FOUND)
    await expectTeamError(MP.findActiveMemberUid(A.db, COMPANY_A, 'nobody@client.test'), CODE.NOT_FOUND)
    await expectTeamError(MP.findActiveMemberUid(A.db, COMPANY_A, 'nonsense'), CODE.INVALID_ARGUMENT)
    await H.deactivateMember(req('u_admin', { uid: 'u_cleo' }))
    await expectTeamError(MP.findActiveMemberUid(A.db, COMPANY_A, 'cleo@client.test'), CODE.NOT_FOUND)
  })

  it('reports assigned projects that have no directory entry', async () => {
    await company(COMPANY_A).collection('projects').doc('bare').set({ name: 'No entry' })
    expect(await MP.projectsWithoutDirectoryEntry(A.db, COMPANY_A, ['p1', 'bare'])).toEqual(['bare'])
    expect(await MP.projectsWithoutDirectoryEntry(A.db, COMPANY_A, [])).toEqual([])
  })
})
