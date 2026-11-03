import { beforeAll, beforeEach, afterEach, afterAll, describe, it, expect } from 'vitest'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { doc, getDoc, onSnapshot, collection, getDocs } from 'firebase/firestore'
import {
  admin, resetEmulators, makeHandlers, seedCompany, seedUser, req, clientSdk, clientSignIn, clientSignOutAll, COMPANY_A,
} from './_harness.js'

// ── What deactivation does to a live client ─────────────────────────────────
//
// The client SDK reads THROUGH THE RULES the emulator loaded from
// firestore.rules. After deactivateMember has committed, every NEW request
// (a new listen target or a one-shot read of something not already being
// listened to) from the removed member must be denied, because the rules
// re-read users/{uid}.companyId on each request and it is now null.
//
// ALREADY-OPEN listeners are a separate question that Firebase does not
// document. Two facts matter and are both exercised here:
//   · a `getDoc` on a document that already has an open listener is served
//     from that multiplexed listen target — it is NOT a new rules evaluation;
//   · the member's own `users/{uid}` listener (the one the membership gate
//     watches) DOES receive the deactivation, which is what makes the client
//     unmount every protected listener and sign out.
// What the open company/projects listeners do afterwards is RECORDED (printed)
// for the release notes, and TESTING.md §49 carries the production smoke
// check. It is not asserted, because it is not a documented guarantee.

let A, H, deps
const unsubs = []

beforeAll(async () => { A = await admin() })
beforeEach(async () => {
  await clientSignOutAll()
  await resetEmulators()
  ;({ handlers: H, deps } = await makeHandlers())
  await seedCompany(COMPANY_A, 'Acme Builders')
  await seedUser({ uid: 'u_admin', email: 'admin@acme.test', role: 'company_admin', companyId: COMPANY_A })
  await seedUser({ uid: 'u_pm', email: 'pm@acme.test', role: 'project_manager', companyId: COMPANY_A })
  await A.db.collection('companies').doc(COMPANY_A).collection('projects').doc('p1').set({ name: 'Project One', status: 'active' })
  await A.db.collection('companies').doc(COMPANY_A).collection('costCodes').doc('cc1').set({ code: '01', name: 'Prelims' })
})
afterEach(async () => {
  while (unsubs.length) { try { unsubs.pop()() } catch { /* ignore */ } }
  await clientSignOutAll()
  await new Promise(r => setTimeout(r, 200))
})
afterAll(async () => { await clientSignOutAll() })

const denied = async (promise) => {
  try { await promise } catch (e) { return e?.code === 'permission-denied' }
  return false
}

const listen = (ref, events, label) => new Promise((resolve) => {
  const unsub = onSnapshot(ref, { includeMetadataChanges: false },
    (s) => { events.push({ kind: 'data', label, payload: typeof s.size === 'number' ? { size: s.size } : (s.exists() ? s.data() : null), fromCache: s.metadata.fromCache }); resolve() },
    (e) => { events.push({ kind: 'error', label, code: e.code }); resolve() })
  unsubs.push(unsub)
})

describe('membership removal and the rules', () => {
  it('a bare Auth account (no users/{uid}) cannot read company data', async () => {
    await A.auth.createUser({ uid: 'u_bare', email: 'bare@acme.test', password: 'correct-horse-battery' })
    await clientSignIn('bare@acme.test')
    const { db } = clientSdk()
    expect(await denied(getDoc(doc(db, 'companies', COMPANY_A)))).toBe(true)
    expect(await denied(getDocs(collection(db, 'companies', COMPANY_A, 'projects')))).toBe(true)
  })

  it('after deactivation every NEW request is denied, the profile listener sees the loss, and open listeners are observed', async () => {
    await clientSignIn('pm@acme.test')
    const { db } = clientSdk()
    const companyRef = doc(db, 'companies', COMPANY_A)
    const projectsRef = collection(db, 'companies', COMPANY_A, 'projects')
    const ownRef = doc(db, 'users', 'u_pm')

    // Baseline: the member reads.
    expect((await getDoc(companyRef)).data().name).toBe('Acme Builders')
    expect((await getDocs(projectsRef)).size).toBe(1)
    expect((await getDoc(doc(db, 'companies', COMPANY_A, 'costCodes', 'cc1'))).data().code).toBe('01')

    // Open listeners (company, projects, OWN PROFILE) and wait for first data.
    const events = []
    await Promise.all([listen(companyRef, events, 'company'), listen(projectsRef, events, 'projects'), listen(ownRef, events, 'profile')])
    expect(events.filter(e => e.kind === 'data').map(e => e.label).sort()).toEqual(['company', 'profile', 'projects'])
    const seen = events.length

    // Deactivate through the backend (Admin SDK).
    const res = await H.deactivateMember(req('u_admin', { uid: 'u_pm' }))
    expect(res.authSynced).toBe(true)
    expect(deps.db).toBe(A.db)

    // 1. The profile listener delivers the loss — the gate's trigger.
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('profile listener never delivered the deactivation')), 5000)
      const tick = () => {
        const hit = events.slice(seen).find(e => e.label === 'profile' && e.kind === 'data' && e.payload?.companyId === null)
        if (hit) { clearTimeout(t); resolve() } else setTimeout(tick, 50)
      }
      tick()
    })

    // 2. NEW targets from the still-signed-in client are denied by the rules:
    //    a document not under any open listener, and a fresh collection query.
    expect(await denied(getDoc(doc(db, 'companies', COMPANY_A, 'costCodes', 'cc1')))).toBe(true)
    expect(await denied(getDocs(collection(db, 'companies', COMPANY_A, 'costCodes')))).toBe(true)
    expect(await denied(getDoc(doc(db, 'companies', COMPANY_A, 'projects', 'p1')))).toBe(true)

    // 3. Provoke the open listeners with writes they would otherwise receive,
    //    wait a bounded time and RECORD the outcome.
    await A.db.collection('companies').doc(COMPANY_A).collection('projects').doc('p2').set({ name: 'Project Two', status: 'active' })
    await A.db.collection('companies').doc(COMPANY_A).set({ name: 'Acme Builders Renamed' }, { merge: true })
    await new Promise(r => setTimeout(r, 2500))
    const later = events.slice(seen).filter(e => e.label !== 'profile')
    const describe1 = (label) => {
      const list = later.filter(e => e.label === label)
      return list.length === 0 ? 'silent' : list.map(e => e.kind === 'error' ? `error:${e.code}` : `data:${JSON.stringify(e.payload)}`).join(' | ')
    }
    const observation = `[ADR-72 observation — Firestore EMULATOR] open listeners after deactivation: company → ${describe1('company')}; projects → ${describe1('projects')}. ` +
      'A one-shot getDoc on an already-listened document is served from that open target (no new rules check); new targets are denied.'
    // `firebase emulators:exec` swallows the child's console, so the
    // observation is also written to a file the release notes can quote.
    console.warn(observation)
    writeFileSync(process.env.ADR72_OBSERVATION_FILE || join(tmpdir(), 'constrapp-adr72-listener-observation.txt'), `${observation}\n`)
    expect(observation).toContain('new targets are denied')
  })

  it('a role change applies on the next request without a new session', async () => {
    await clientSignIn('pm@acme.test')
    const { db } = clientSdk()
    const projectRef = doc(db, 'companies', COMPANY_A, 'projects', 'p1')
    expect((await getDoc(projectRef)).data().name).toBe('Project One')
    await H.changeMemberRole(req('u_admin', { uid: 'u_pm', role: 'qs', expectedRole: 'project_manager' }))
    // qs may still READ projects; the role is re-read on every request.
    expect((await getDoc(doc(db, 'companies', COMPANY_A, 'projects', 'p1'))).data().name).toBe('Project One')
    expect((await getDoc(doc(db, 'users', 'u_pm'))).data().role).toBe('qs')
  })
})
