import { beforeAll, beforeEach, afterAll, describe, it, expect } from 'vitest'
import { createUserWithEmailAndPassword } from 'firebase/auth'
import {
  admin, resetEmulators, seedCompany, seedUser, parseLink, callFunction, clientSdk, clientSignIn, clientSignOutAll,
  COMPANY_A,
} from './_harness.js'

// ── Real callables through the Functions emulator ───────────────────────────
//
// `functions/src/index.js` as deployed: onCall wrappers, App Check
// enforcement, the secret binding (unset here → the dev-outbox mailer), the
// env file for the test project. The callable protocol is driven over HTTP
// exactly as the client SDK does it, with an ID token from the Auth emulator
// and a minted App Check token (the emulator runs with token verification
// skipped — see _harness.js).

let A

beforeAll(async () => { A = await admin() })
beforeEach(async () => { await clientSignOutAll(); await resetEmulators() })
afterAll(async () => { await clientSignOutAll() })

const outbox = (companyId, inviteId) =>
  A.db.collection('companies').doc(companyId).collection('devOutbox').doc(inviteId).get().then(s => (s.exists ? s.data() : null))

describe('App Check enforcement', () => {
  it('a request without an App Check token is refused before the handler runs', async () => {
    const r = await callFunction('previewInvitation', { companyId: 'c', inviteId: 'i', token: 'A'.repeat(43) }, { appCheck: null })
    expect(r.status).toBe(401)
    expect(r.error).toMatchObject({ status: 'UNAUTHENTICATED' })
    expect(r.error.details).toBeUndefined()
  })

  it('a request with an App Check token reaches the handler and gets a typed refusal', async () => {
    const r = await callFunction('previewInvitation', { companyId: 'c', inviteId: 'i', token: 'A'.repeat(43) })
    expect(r.status).toBe(404)
    expect(r.error).toMatchObject({ status: 'NOT_FOUND', details: { code: 'invalid-invitation' } })
  })

  it('an authenticated callable refuses a caller without membership, with a typed code', async () => {
    const { auth } = clientSdk()
    await createUserWithEmailAndPassword(auth, 'bare@callable.test', 'correct-horse-battery')
    const idToken = await auth.currentUser.getIdToken()
    const r = await callFunction('listTeam', {}, { idToken })
    expect(r.status).toBe(403)
    expect(r.error).toMatchObject({ status: 'PERMISSION_DENIED', details: { code: 'no-membership' } })
  })
})

describe('end-to-end: invite → preview → register → accept → list', () => {
  it('completes through the deployed wrappers with the dev outbox carrying the link', async () => {
    await seedCompany(COMPANY_A, 'Acme Builders')
    await seedUser({ uid: 'u_admin', email: 'admin@acme.test', role: 'company_admin', companyId: COMPANY_A, name: 'Ada Admin' })

    // 1. Admin signs in through the Auth emulator and invites.
    const adminUser = await clientSignIn('admin@acme.test')
    const adminToken = await adminUser.getIdToken()
    const created = await callFunction('createInvitation', { email: 'New@Acme.test', role: 'qs' }, { idToken: adminToken })
    expect(created.status).toBe(200)
    expect(created.result).toMatchObject({ email: 'new@acme.test', role: 'qs', delivery: 'sent' })
    expect(created.result.link).toBeUndefined()

    // The emulator's dev outbox holds the rendered email and the link.
    const mail = await outbox(COMPANY_A, created.result.inviteId)
    expect(mail).toBeTruthy()
    expect(mail.to).toBe('new@acme.test')
    const cred = parseLink(mail.link)
    expect(cred).toMatchObject({ companyId: COMPANY_A, inviteId: created.result.inviteId })

    // 2. The invitee previews WITHOUT signing in (App Check only).
    const preview = await callFunction('previewInvitation', cred)
    expect(preview.status).toBe(200)
    expect(preview.result).toMatchObject({ companyName: 'Acme Builders', email: 'new@acme.test', role: 'qs', accountState: 'new' })

    // 3. They register through the browser SDK (no password ever reaches a callable) …
    await clientSignOutAll()
    const { auth } = clientSdk()
    const reg = await createUserWithEmailAndPassword(auth, 'new@acme.test', 'a-long-enough-password')
    const newToken = await reg.user.getIdToken()

    // … and a bare account has no membership: listTeam refuses it.
    const bare = await callFunction('listTeam', {}, { idToken: newToken })
    expect(bare.error).toMatchObject({ details: { code: 'no-membership' } })

    // 4. They accept with the token.
    const accepted = await callFunction('acceptInvitation', { ...cred, name: 'Nia New' }, { idToken: newToken })
    expect(accepted.status).toBe(200)
    expect(accepted.result).toMatchObject({ uid: reg.user.uid, companyId: COMPANY_A, role: 'qs' })

    const profile = await A.db.collection('users').doc(reg.user.uid).get()
    expect(profile.data()).toMatchObject({ companyId: COMPANY_A, role: 'qs', status: 'active', name: 'Nia New' })

    // 5. Repeating the acceptance is a no-op success; the admin sees the member.
    const again = await callFunction('acceptInvitation', cred, { idToken: newToken })
    expect(again.result).toMatchObject({ alreadyAccepted: true })

    await clientSignOutAll()
    const admin2 = await clientSignIn('admin@acme.test')
    const list = await callFunction('listTeam', {}, { idToken: await admin2.getIdToken() })
    expect(list.status).toBe(200)
    expect(list.result.members.find(m => m.uid === reg.user.uid)).toMatchObject({ role: 'qs', status: 'active' })
    expect(list.result.invitations).toEqual([])

    // 6. Role change and deactivation through the wrappers.
    const roleRes = await callFunction('changeMemberRole', { uid: reg.user.uid, role: 'project_manager', expectedRole: 'qs' }, { idToken: await admin2.getIdToken() })
    expect(roleRes.result).toMatchObject({ role: 'project_manager', changed: true })
    const deact = await callFunction('deactivateMember', { uid: reg.user.uid }, { idToken: await admin2.getIdToken() })
    expect(deact.result).toMatchObject({ status: 'deactivated', authSynced: true })
    expect((await A.auth.getUser(reg.user.uid)).disabled).toBe(true)
  })

  it('malformed input through the wire is refused as invalid-argument', async () => {
    await seedCompany(COMPANY_A)
    await seedUser({ uid: 'u_admin', email: 'admin@acme.test', role: 'company_admin', companyId: COMPANY_A })
    const adminUser = await clientSignIn('admin@acme.test')
    const idToken = await adminUser.getIdToken()
    for (const data of [null, [], { email: 'x', role: 'qs' }, { email: 'a@b.co', role: 'client' }, { email: 'a@b.co', role: 'qs', extra: 1 }]) {
      const r = await callFunction('createInvitation', data, { idToken })
      expect(r.status, JSON.stringify(data)).toBe(400)
      expect(['invalid-argument', 'invalid-role']).toContain(r.error.details.code)
    }
  })
})
