import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createTeamHandlers, HANDLER_NAMES } from '../src/team/handlers.js'
import { CODE, isTeamError } from '../src/lib/errors.js'

// Structural pins and the handler gates that need no Firestore at all.

const INDEX = readFileSync(fileURLToPath(new URL('../src/index.js', import.meta.url)), 'utf8')

const deps = (overrides = {}) => ({
  db: null, auth: null, email: null, now: () => new Date('2026-11-04T10:00:00Z'),
  config: () => ({ appBaseUrl: 'http://localhost', emailFrom: 'a@b', enabled: true, inviteTtlMs: 1000 }),
  log: { info() {}, warn() {}, error() {} }, ...overrides,
})

describe('callable surface', () => {
  it('exactly eight handlers, each exported from index.js with onCall', () => {
    expect(HANDLER_NAMES).toEqual([
      'listTeam', 'createInvitation', 'resendInvitation', 'revokeInvitation',
      'previewInvitation', 'acceptInvitation', 'changeMemberRole', 'deactivateMember',
    ])
    const h = createTeamHandlers(deps())
    for (const n of HANDLER_NAMES) {
      expect(typeof h[n]).toBe('function')
      expect(INDEX).toContain(`export const ${n}`)
    }
    expect((INDEX.match(/wrap\('/g) || []).length).toBe(8)
  })

  it('every callable enforces App Check, one region, a secret binding and an instance cap', () => {
    expect(INDEX).toMatch(/enforceAppCheck:\s*true/)
    expect(INDEX).toMatch(/region:\s*REGION/)
    expect(INDEX).toMatch(/secrets:\s*\[EMAIL_API_KEY\]/)
    expect(INDEX).toMatch(/maxInstances:\s*\d+/)
    expect(INDEX).not.toMatch(/from\s*'express'|onRequest\(/)
  })

  it('the kill switch answers team-management-disabled before any data access', async () => {
    const h = createTeamHandlers(deps({ config: () => ({ enabled: false }) }))
    for (const n of HANDLER_NAMES) {
      try { await h[n]({ auth: { uid: 'u' }, data: {} }); throw new Error('no throw') }
      catch (e) { expect(isTeamError(e, CODE.DISABLED)).toBe(true) }
    }
  })

  it('an unauthenticated caller is refused by every authenticated callable before validation', async () => {
    const h = createTeamHandlers(deps())
    for (const n of HANDLER_NAMES.filter(x => x !== 'previewInvitation')) {
      try { await h[n]({ auth: null, data: { nonsense: true } }); throw new Error('no throw') }
      catch (e) { expect(isTeamError(e, CODE.UNAUTHENTICATED), n).toBe(true) }
    }
  })

  it('previewInvitation validates its credential shape before any lookup', async () => {
    const h = createTeamHandlers(deps())
    try { await h.previewInvitation({ auth: null, data: { companyId: 'c', inviteId: 'i', token: 'bad' } }); throw new Error('no throw') }
    catch (e) { expect(isTeamError(e, CODE.INVALID_ARGUMENT)).toBe(true) }
  })
})
