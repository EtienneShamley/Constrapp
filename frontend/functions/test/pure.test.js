import { describe, it, expect } from 'vitest'
import { generateToken, hashToken, tokenMatchesHash, buildInviteLink } from '../src/lib/tokens.js'
import {
  parseCreateInvitation, parseInviteCredential, parseAcceptInvitation, parseChangeMemberRole, parseMemberUid,
  parseInviteId, parseEmpty, normaliseEmail, isValidEmail, isTokenShape, INTERNAL_ROLES, OPERATOR_ROLES,
} from '../src/lib/validation.js'
import { CODE, TeamError, isTeamError } from '../src/lib/errors.js'
import {
  effectiveInviteStatus, isActiveMember, isActiveMemberOf, isActiveAdminOf, isDeactivated, INVITE_STATUS,
  INVITE_MAX_FAILED_ATTEMPTS, toMillis,
} from '../src/lib/membershipState.js'
import { renderInviteEmail, createResendAdapter, EmailError, isEmulatorRuntime, RESEND_ENDPOINT } from '../src/lib/email.js'
import { rateKey } from '../src/lib/rateLimit.js'

// ── Pure-logic tests for the Functions package (no emulator, no network) ────
// The emulator-backed behaviour (transactions, Auth, callables) is covered by
// frontend/tests/functions/ via `npm run test:functions`.

const NOW = new Date('2026-11-04T10:00:00Z')
const code = (fn, expected) => {
  try { fn() } catch (e) { expect(isTeamError(e, expected), `expected ${expected}, got ${e?.details?.code ?? e}`).toBe(true); return }
  throw new Error(`expected ${expected} to be thrown`)
}

describe('tokens', () => {
  it('generates 43-char base64url tokens with 256 bits of entropy', () => {
    const t = generateToken()
    expect(isTokenShape(t)).toBe(true)
    expect(Buffer.from(t, 'base64url').length).toBe(32)
    expect(generateToken()).not.toBe(t)
  })
  it('stores and compares only the SHA-256 hash, constant-time', () => {
    const t = generateToken()
    const h = hashToken(t)
    expect(h).toMatch(/^[0-9a-f]{64}$/)
    expect(h).not.toContain(t)
    expect(tokenMatchesHash(t, h)).toBe(true)
    expect(tokenMatchesHash(generateToken(), h)).toBe(false)
    expect(tokenMatchesHash(t, '')).toBe(false)
    expect(tokenMatchesHash(null, h)).toBe(false)
    expect(tokenMatchesHash(t, 'zz')).toBe(false)
  })
  it('puts the credential in the URL fragment, never the query', () => {
    const link = buildInviteLink('https://app.example/', { companyId: 'c1', inviteId: 'i1', token: 'T_-x' })
    expect(link).toBe('https://app.example/accept-invite#c=c1&i=i1&t=T_-x')
    expect(link).not.toContain('?')
  })
})

describe('validation', () => {
  it('normalises and validates emails', () => {
    expect(normaliseEmail('  Jo@Example.COM ')).toBe('jo@example.com')
    expect(isValidEmail('jo@example.com')).toBe(true)
    expect(isValidEmail('jo@example')).toBe(false)
    expect(isValidEmail('jo example@x.com')).toBe(false)
    expect(isValidEmail('a'.repeat(250) + '@x.com')).toBe(false)
  })
  it('only the three internal roles are assignable', () => {
    expect(INTERNAL_ROLES).toEqual(['company_admin', 'project_manager', 'qs'])
    expect(OPERATOR_ROLES).toEqual(['super_admin', 'subcontractor', 'client'])
    for (const r of OPERATOR_ROLES) code(() => parseCreateInvitation({ email: 'a@b.co', role: r }), CODE.INVALID_ROLE)
    code(() => parseCreateInvitation({ email: 'a@b.co', role: 'owner' }), CODE.INVALID_ROLE)
    expect(parseCreateInvitation({ email: ' A@B.co ', role: 'qs' })).toEqual({ email: 'a@b.co', role: 'qs' })
  })
  it('refuses unknown keys, non-objects and malformed ids', () => {
    code(() => parseCreateInvitation({ email: 'a@b.co', role: 'qs', companyId: 'x' }), CODE.INVALID_ARGUMENT)
    code(() => parseCreateInvitation(null), CODE.INVALID_ARGUMENT)
    code(() => parseCreateInvitation([]), CODE.INVALID_ARGUMENT)
    code(() => parseInviteId({ inviteId: '../x' }), CODE.INVALID_ARGUMENT)
    code(() => parseInviteId({}), CODE.INVALID_ARGUMENT)
    code(() => parseEmpty({ anything: 1 }), CODE.INVALID_ARGUMENT)
    expect(parseEmpty(undefined)).toEqual({})
    code(() => parseMemberUid({ uid: '' }), CODE.INVALID_ARGUMENT)
    code(() => parseMemberUid({ uid: 'a'.repeat(129) }), CODE.INVALID_ARGUMENT)
    expect(parseMemberUid({ uid: 'u_1' })).toEqual({ uid: 'u_1' })
  })
  it('credential parsing requires a well-formed token', () => {
    const t = generateToken()
    expect(parseInviteCredential({ companyId: 'c', inviteId: 'i', token: t })).toEqual({ companyId: 'c', inviteId: 'i', token: t })
    code(() => parseInviteCredential({ companyId: 'c', inviteId: 'i', token: 'short' }), CODE.INVALID_ARGUMENT)
    code(() => parseInviteCredential({ companyId: 'c', inviteId: 'i', token: t, name: 'x' }), CODE.INVALID_ARGUMENT)
    expect(parseAcceptInvitation({ companyId: 'c', inviteId: 'i', token: t, name: ' Jo ' }).name).toBe('Jo')
    expect(parseAcceptInvitation({ companyId: 'c', inviteId: 'i', token: t }).name).toBe('')
    code(() => parseAcceptInvitation({ companyId: 'c', inviteId: 'i', token: t, name: 'x'.repeat(81) }), CODE.INVALID_ARGUMENT)
  })
  it('role change requires a valid target role and expectation', () => {
    expect(parseChangeMemberRole({ uid: 'u', role: 'qs', expectedRole: 'project_manager' })).toEqual({ uid: 'u', role: 'qs', expectedRole: 'project_manager' })
    code(() => parseChangeMemberRole({ uid: 'u', role: 'client', expectedRole: 'qs' }), CODE.INVALID_ROLE)
    code(() => parseChangeMemberRole({ uid: 'u', role: 'qs', expectedRole: 'client' }), CODE.INVALID_ARGUMENT)
  })
})

describe('errors', () => {
  it('every code maps to a gRPC status and carries details.code', () => {
    for (const c of Object.values(CODE)) {
      const e = new TeamError(c, { x: 1 })
      expect(e.details).toEqual({ code: c, x: 1 })
      expect(typeof e.code).toBe('string')
    }
    expect(() => new TeamError('nope')).toThrow()
  })
})

describe('membership state', () => {
  it('a missing status is active (legacy profiles), a null companyId is no member', () => {
    expect(isActiveMember({ companyId: 'c', role: 'qs' })).toBe(true)
    expect(isActiveMember({ companyId: 'c', role: 'qs', status: 'active' })).toBe(true)
    expect(isActiveMember({ companyId: 'c', role: 'qs', status: 'deactivated' })).toBe(false)
    expect(isActiveMember({ companyId: null, role: null, status: 'deactivated' })).toBe(false)
    expect(isActiveMember({ companyId: '', role: 'qs' })).toBe(false)
    expect(isActiveMember(null)).toBe(false)
    expect(isDeactivated({ status: 'deactivated' })).toBe(true)
    expect(isActiveMemberOf({ companyId: 'c' }, 'c')).toBe(true)
    expect(isActiveMemberOf({ companyId: 'c' }, 'd')).toBe(false)
    expect(isActiveAdminOf({ companyId: 'c', role: 'company_admin' }, 'c')).toBe(true)
    expect(isActiveAdminOf({ companyId: 'c', role: 'qs' }, 'c')).toBe(false)
  })
  it('derives expired and locked from a pending record without writing', () => {
    const future = new Date(NOW.getTime() + 1000)
    const past = new Date(NOW.getTime() - 1000)
    expect(effectiveInviteStatus({ status: 'pending', expiresAt: future }, NOW)).toBe(INVITE_STATUS.PENDING)
    expect(effectiveInviteStatus({ status: 'pending', expiresAt: past }, NOW)).toBe(INVITE_STATUS.EXPIRED)
    expect(effectiveInviteStatus({ status: 'pending', expiresAt: NOW }, NOW)).toBe(INVITE_STATUS.EXPIRED)
    expect(effectiveInviteStatus({ status: 'pending', expiresAt: future, failedAttempts: INVITE_MAX_FAILED_ATTEMPTS }, NOW)).toBe(INVITE_STATUS.LOCKED)
    expect(effectiveInviteStatus({ status: 'accepted', expiresAt: past }, NOW)).toBe(INVITE_STATUS.ACCEPTED)
    expect(effectiveInviteStatus({ status: 'revoked', expiresAt: future }, NOW)).toBe(INVITE_STATUS.REVOKED)
    expect(effectiveInviteStatus(null, NOW)).toBe(null)
  })
  it('reads Firestore Timestamps, Dates and numbers', () => {
    expect(toMillis({ seconds: 1, nanoseconds: 5e6 })).toBe(1005)
    expect(toMillis({ toMillis: () => 7 })).toBe(7)
    expect(toMillis(NOW)).toBe(NOW.getTime())
    expect(toMillis(null)).toBe(null)
  })
})

describe('email', () => {
  it('renders an invitation with the link and escapes html', () => {
    const r = renderInviteEmail({ companyName: 'A <B>', inviterName: 'Jo', role: 'qs', link: 'https://x/accept-invite#t=1', expiresAt: NOW })
    expect(r.subject).toBe("You're invited to A <B> on Constrap")
    expect(r.text).toContain('https://x/accept-invite#t=1')
    expect(r.text).toContain('Quantity Surveyor')
    expect(r.html).toContain('A &lt;B&gt;')
    expect(r.html).not.toContain('<B>')
  })
  it('the Resend adapter refuses to send unconfigured, retries 5xx once, never retries 4xx', async () => {
    await expect(createResendAdapter({ apiKey: '', from: 'a@b' }).send({ to: 'x@y', subject: 's', text: 't', html: 'h' }))
      .rejects.toMatchObject({ code: 'not-configured' })

    const calls = []
    const fetch500 = async (url, init) => { calls.push({ url, init }); return { ok: false, status: 500, json: async () => ({}) } }
    const a = createResendAdapter({ apiKey: 'k', from: 'a@b', fetchImpl: fetch500, retryDelayMs: 1 })
    await expect(a.send({ to: 'x@y', subject: 's', text: 't', html: 'h', idempotencyKey: 'ik' })).rejects.toBeInstanceOf(EmailError)
    expect(calls.length).toBe(2)
    expect(calls[0].url).toBe(RESEND_ENDPOINT)
    expect(calls[0].init.headers['Idempotency-Key']).toBe('ik')
    expect(calls[0].init.headers.Authorization).toBe('Bearer k')
    expect(JSON.parse(calls[0].init.body)).toMatchObject({ from: 'a@b', to: ['x@y'], subject: 's' })

    const calls4 = []
    const fetch422 = async (u, i) => { calls4.push(i); return { ok: false, status: 422, json: async () => ({}) } }
    await expect(createResendAdapter({ apiKey: 'k', from: 'a@b', fetchImpl: fetch422, retryDelayMs: 1 }).send({ to: 'x@y', subject: 's', text: 't', html: 'h' }))
      .rejects.toMatchObject({ code: 'provider-error', status: 422 })
    expect(calls4.length).toBe(1)

    const ok = createResendAdapter({ apiKey: 'k', from: 'a@b', fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ id: 'abc' }) }) })
    expect(await ok.send({ to: 'x@y', subject: 's', text: 't', html: 'h' })).toEqual({ providerId: 'abc' })
  })
  it('the dev outbox is selected only inside the emulator WITH a Firestore emulator, never on Cloud Run', () => {
    expect(isEmulatorRuntime({ FUNCTIONS_EMULATOR: 'true', FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080' })).toBe(true)
    expect(isEmulatorRuntime({ FUNCTIONS_EMULATOR: 'true', FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080', K_SERVICE: 'listTeam' })).toBe(true)
    expect(isEmulatorRuntime({ FUNCTIONS_EMULATOR: 'true' })).toBe(false)
    expect(isEmulatorRuntime({ FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080', K_SERVICE: 'listTeam' })).toBe(false)
    expect(isEmulatorRuntime({})).toBe(false)
  })
})

describe('rate limit keys', () => {
  it('are safe document ids', () => {
    expect(rateKey('invite-create', 'a/b c@d')).toBe('invite-create__a_b_c_d')
    expect(rateKey('x'.repeat(300)).length).toBeLessThanOrEqual(200)
  })
})
