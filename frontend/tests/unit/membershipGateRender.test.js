import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

// ── Membership gate: what each state shows (tracker D3 #32) ──────────────────
//
// The gate rendered with react-dom/server over a stubbed profile context (no
// DOM, no Firebase). The state logic and the listener lifecycle are covered in
// membershipResolution.test.js; this file pins the WORDS, because the defect
// was a false sentence: *No active membership* shown to a member whose
// membership had simply not been read yet.

const S = vi.hoisted(() => ({ ctx: null }))

vi.mock('react-router-dom', () => ({ Outlet: () => 'PROTECTED-APP-SHELL' }))
vi.mock('../../src/hooks/useAuth', () => ({ useAuth: () => ({ user: { uid: 'u1', email: 'pat@example.test' }, signOut: () => Promise.resolve() }) }))
vi.mock('../../src/hooks/useProfile', () => ({ useProfile: () => S.ctx }))

const { default: MembershipGate } = await import('../../src/components/MembershipGate')
const { GATE } = await import('../../src/lib/team')

const context = (over = {}) => ({
  profile: null, profileLoading: false, profileError: false, profileErrorCode: null, profileWaiting: false,
  retryProfile: () => {}, ...over,
})
const render = (over) => { S.ctx = context(over); return renderToStaticMarkup(h(MembershipGate)) }

const STATES = {
  loading:     { profileLoading: true },
  waiting:     { profileLoading: true, profileWaiting: true },
  active:      { profile: { companyId: 'c1', role: 'qs', status: 'active' } },
  none:        {},
  deactivated: { profile: { companyId: null, role: 'qs', status: 'deactivated' } },
  invalid:     { profile: { companyId: 'c1', role: 'owner', status: 'active' } },
  refused:     { profileError: true, profileErrorCode: 'permission-denied' },
  error:       { profileError: true, profileErrorCode: 'unavailable' },
}

beforeEach(() => { S.ctx = context() })

describe('MembershipGate — rendered states', () => {
  it('covers every gate state', () => {
    expect(Object.keys(STATES).sort()).toEqual(Object.values(GATE).sort())
  })

  it('the protected shell renders for an active membership and for nothing else', () => {
    for (const [name, over] of Object.entries(STATES)) {
      const html = render(over)
      expect(html.includes('PROTECTED-APP-SHELL'), name).toBe(name === 'active')
    }
  })

  it('"No active membership" appears only for a server-confirmed absence', () => {
    for (const [name, over] of Object.entries(STATES)) {
      expect(render(over).includes('No active membership'), name).toBe(name === 'none')
    }
  })

  it('"deactivated" appears only for a server-confirmed deactivation', () => {
    for (const [name, over] of Object.entries(STATES)) {
      expect(render(over).includes('Your membership was deactivated'), name).toBe(name === 'deactivated')
    }
  })

  it('loading is the spinner alone', () => {
    const html = render(STATES.loading)
    expect(html).toContain('aria-label="Loading"')
    expect(html).not.toContain('<h1')
    expect(html).not.toContain('Sign out')
  })

  it('waiting says so, promises to continue by itself, and offers sign-out but no retry', () => {
    const html = render(STATES.waiting)
    expect(html).toContain('data-membership-gate="waiting"')
    expect(html).toContain('Waiting for the server')
    expect(html).toContain('your membership cannot be confirmed')
    expect(html).toContain('continue by itself when the connection returns')
    expect(html).toContain('role="status"')
    expect(html).toContain('Sign out')
    expect(html).not.toContain('Try again')
    expect(html).not.toMatch(/not a member|deactivated|refused/)
  })

  it('a refused read and a failed read each say what happened and offer Try again', () => {
    const refused = render(STATES.refused)
    expect(refused).toContain('data-membership-gate="refused"')
    expect(refused).toContain('Your membership could not be confirmed')
    expect(refused).toContain('The server refused to read your membership')
    expect(refused).toContain('Try again')
    expect(refused).toContain('Sign out')

    const failed = render(STATES.error)
    expect(failed).toContain('data-membership-gate="error"')
    expect(failed).toContain('Could not load your membership')
    expect(failed).toContain('a loading failure, not a missing membership')
    expect(failed).toContain('Try again')
    expect(failed).not.toContain('Reload')
  })

  it('an invalid membership says so — not a denial, not a connection problem, no retry, no shell', () => {
    for (const profile of [
      { companyId: 'c1', status: 'active' }, { companyId: 'c1', role: null }, { companyId: 'c1', role: '' },
      { companyId: 'c1', role: 'owner' }, { companyId: 'c1', role: 7 }, { companyId: 42, role: 'company_admin' },
    ]) {
      const html = render({ profile })
      expect(html, JSON.stringify(profile)).toContain('data-membership-gate="invalid"')
      expect(html).toContain('Your membership needs attention')
      expect(html).toContain('This is not a connection problem')
      expect(html).toContain('continue by itself once the record is corrected')
      expect(html).toContain('Sign out')
      expect(html).not.toContain('PROTECTED-APP-SHELL')
      expect(html).not.toContain('Try again')
      expect(html).not.toMatch(/No active membership|Waiting for the server|deactivated/)
      // The stored value is never echoed back.
      expect(html).not.toMatch(/owner|>7<|42/)
    }
  })

  it('every supported role renders the shell', () => {
    for (const role of ['company_admin', 'project_manager', 'qs', 'subcontractor', 'client', 'super_admin']) {
      expect(render({ profile: { companyId: 'c1', role, status: 'active' } }), role).toContain('PROTECTED-APP-SHELL')
    }
  })

  it('no notice shows raw SDK text or an error code', () => {
    for (const over of Object.values(STATES)) {
      expect(render(over)).not.toMatch(/FirebaseError|permission-denied|unavailable<|firestore\//i)
    }
  })

  it('every notice names the signed-in account, so a wrong account is recognisable', () => {
    for (const name of ['waiting', 'none', 'deactivated', 'invalid', 'refused', 'error']) {
      expect(render(STATES[name]), name).toContain('pat@example.test')
    }
  })

  it('a waiting flag wins over any profile passed with it — nothing protected renders', () => {
    const html = render({ ...STATES.active, profileLoading: true, profileWaiting: true })
    expect(html).not.toContain('PROTECTED-APP-SHELL')
    expect(html).toContain('Waiting for the server')
  })
})
