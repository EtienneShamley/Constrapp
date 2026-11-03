// ── Shared harness for the trusted-backend suite (ADR-72) ────────────────────
//
// Runs ONLY inside `firebase emulators:exec --only auth,firestore,functions`
// (npm run test:functions). Two SDKs talk to the same emulators:
//   · the Admin SDK (from functions/node_modules, through the functions
//     package's own wrapper) — seeds data and drives the handlers directly
//   · the client SDK (this package) — signs in through the Auth emulator and
//     reads Firestore THROUGH THE RULES, which the emulator loads from
//     firebase.json, so "the next request is denied" is a real rules verdict
//
// Every test file refuses to run without BOTH emulator hosts, so nothing here
// can ever reach a real project.

import { createHash } from 'node:crypto'
import { initializeApp as initClientApp, getApps as getClientApps } from 'firebase/app'
import { getAuth as getClientAuth, connectAuthEmulator, signInWithEmailAndPassword, signOut as clientSignOut } from 'firebase/auth'
import { getFirestore as getClientFirestore, connectFirestoreEmulator } from 'firebase/firestore'

export const PROJECT_ID = 'constrapp-rules-test'
export const REGION = 'australia-southeast1'
export const FUNCTIONS_PORT = 5001

export function requireEmulators() {
  if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_AUTH_EMULATOR_HOST) {
    throw new Error('FIRESTORE_EMULATOR_HOST / FIREBASE_AUTH_EMULATOR_HOST not set — refusing to run outside the emulators. Run `npm run test:functions`.')
  }
}

const hostPort = (env) => { const [host, port] = env.split(':'); return { host, port: Number(port) } }

// ── Admin side ───────────────────────────────────────────────────────────────

let adminMods = null
export async function admin() {
  requireEmulators()
  if (adminMods) return adminMods
  process.env.GCLOUD_PROJECT ??= PROJECT_ID
  const fb = await import('../../functions/src/lib/firebaseAdmin.js')
  const handlers = await import('../../functions/src/team/handlers.js')
  const errors = await import('../../functions/src/lib/errors.js')
  const invitations = await import('../../functions/src/lib/invitations.js')
  const members = await import('../../functions/src/lib/members.js')
  const tokens = await import('../../functions/src/lib/tokens.js')
  adminMods = {
    db: fb.getDb(), auth: fb.getAdminAuth(), Timestamp: fb.Timestamp, FieldValue: fb.FieldValue,
    createTeamHandlers: handlers.createTeamHandlers, CODE: errors.CODE, isTeamError: errors.isTeamError,
    invitations, members, tokens,
  }
  return adminMods
}

// Wipe both emulators between tests (REST endpoints the emulators expose).
export async function resetEmulators() {
  const fs = hostPort(process.env.FIRESTORE_EMULATOR_HOST)
  const au = hostPort(process.env.FIREBASE_AUTH_EMULATOR_HOST)
  // The Firestore clear can answer 500 while a client listener from the
  // previous test is still tearing down; retry briefly before failing.
  let last = null
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const r1 = await fetch(`http://${fs.host}:${fs.port}/emulator/v1/projects/${PROJECT_ID}/databases/(default)/documents`, { method: 'DELETE' })
    const r2 = await fetch(`http://${au.host}:${au.port}/emulator/v1/projects/${PROJECT_ID}/accounts`, { method: 'DELETE' })
    if (r1.ok && r2.ok) return
    last = `firestore ${r1.status}, auth ${r2.status}`
    await new Promise(r => setTimeout(r, 400))
  }
  throw new Error(`emulator reset failed: ${last}`)
}

// ── Test doubles ─────────────────────────────────────────────────────────────

export function fakeMailer() {
  const sent = []
  const state = { failWith: null }
  return {
    sent, state,
    kind: 'fake',
    async send(msg) {
      if (state.failWith) { const err = state.failWith; throw err }
      sent.push(msg)
      return { providerId: `fake-${sent.length}` }
    },
    lastLink() { return sent.at(-1)?.meta?.link ?? null },
  }
}

export function clock(startIso = '2026-11-04T10:00:00Z') {
  let t = new Date(startIso).getTime()
  const fn = () => new Date(t)
  fn.advance = (ms) => { t += ms }
  fn.set = (iso) => { t = new Date(iso).getTime() }
  return fn
}

export const DAY = 24 * 60 * 60 * 1000

export const silentLog = { info() {}, warn() {}, error() {}, debug() {} }

export async function makeHandlers({ mailer = fakeMailer(), now = clock(), config = {}, auth = null } = {}) {
  const a = await admin()
  const cfg = { appBaseUrl: 'http://localhost:5173', emailFrom: 'Constrapp <noreply@localhost>', enabled: true, inviteTtlMs: 7 * DAY, ...config }
  const deps = { db: a.db, auth: auth ?? a.auth, email: mailer, now, config: () => cfg, log: silentLog }
  return { handlers: a.createTeamHandlers(deps), deps, mailer, now, cfg }
}

// ── Seeding ──────────────────────────────────────────────────────────────────

export const COMPANY_A = 'companyA'
export const COMPANY_B = 'companyB'

export async function seedCompany(id, name = `Company ${id}`) {
  const a = await admin()
  await a.db.collection('companies').doc(id).set({ name, countryCode: 'AU', baseCurrency: 'AUD' })
}

// An Auth account plus the authoritative users/{uid} profile, exactly as the
// console provisioning (pre-ADR-72) produced it. `legacy: true` omits the
// ADR-72 fields (status, joinedAt) to mirror pre-existing documents.
export async function seedUser({ uid, email, role, companyId, name = uid, password = 'correct-horse-battery', legacy = false, profile = true }) {
  const a = await admin()
  await a.auth.createUser({ uid, email, password, displayName: name, emailVerified: true })
  if (profile) {
    const doc = legacy
      ? { name, email, role, companyId }
      : { name, email, role, companyId, status: 'active', joinedAt: a.Timestamp.fromDate(new Date('2026-01-01T00:00:00Z')) }
    await a.db.collection('users').doc(uid).set(doc)
  }
  return { uid, email, role, companyId }
}

export const req = (uid, data = {}) => ({ auth: uid ? { uid, token: {} } : null, data, rawRequest: { headers: {} } })

export async function expectTeamError(promise, code) {
  const a = await admin()
  try {
    await promise
  } catch (e) {
    if (!a.isTeamError(e, code)) throw new Error(`expected team error "${code}", got ${e?.details?.code ?? e?.message ?? e}`, { cause: e })
    return e
  }
  throw new Error(`expected team error "${code}" but the call succeeded`)
}

export function parseLink(link) {
  const hash = link.split('#')[1]
  const p = new URLSearchParams(hash)
  return { companyId: p.get('c'), inviteId: p.get('i'), token: p.get('t') }
}

export const sha256 = (s) => createHash('sha256').update(s).digest('hex')

// ── Client side ──────────────────────────────────────────────────────────────

let client = null
export function clientSdk() {
  requireEmulators()
  if (client) return client
  const app = getClientApps()[0] ?? initClientApp({ projectId: PROJECT_ID, apiKey: 'fake-api-key', appId: '1:1:web:test' })
  const auth = getClientAuth(app)
  const db = getClientFirestore(app)
  const au = hostPort(process.env.FIREBASE_AUTH_EMULATOR_HOST)
  const fs = hostPort(process.env.FIRESTORE_EMULATOR_HOST)
  connectAuthEmulator(auth, `http://${au.host}:${au.port}`, { disableWarnings: true })
  connectFirestoreEmulator(db, fs.host, fs.port)
  client = { app, auth, db }
  return client
}

export async function clientSignIn(email, password = 'correct-horse-battery') {
  const { auth } = clientSdk()
  const cred = await signInWithEmailAndPassword(auth, email, password)
  return cred.user
}

export async function clientSignOutAll() {
  if (!client) return
  try { await clientSignOut(client.auth) } catch { /* ignore */ }
}

// ── Callable protocol through the Functions emulator ─────────────────────────

const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')

// The emulator runs with skipTokenVerification, so an UNSIGNED token of the
// right shape is decoded and accepted. Production verifies the signature with
// the App Check service — this never works there.
export const mintAppCheckToken = () =>
  `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url({ sub: '1:1:web:test', aud: [`projects/${PROJECT_ID}`], exp: Math.floor(Date.now() / 1000) + 3600, iat: Math.floor(Date.now() / 1000) })}.`

export async function callFunction(name, data, { idToken = null, appCheck = mintAppCheckToken() } = {}) {
  const headers = { 'Content-Type': 'application/json' }
  if (idToken) headers.Authorization = `Bearer ${idToken}`
  if (appCheck) headers['X-Firebase-AppCheck'] = appCheck
  const res = await fetch(`http://127.0.0.1:${FUNCTIONS_PORT}/${PROJECT_ID}/${REGION}/${name}`, {
    method: 'POST', headers, body: JSON.stringify({ data }),
  })
  const body = await res.json().catch(() => ({}))
  return { status: res.status, result: body.result, error: body.error ?? null }
}
