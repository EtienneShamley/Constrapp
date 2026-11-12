import { describe, it, expect } from 'vitest'
import {
  TEAM_ROLES, TEAM_ROLE_VALUES, isTeamRole, canManageTeam,
  parseInviteFragment, isInviteCredential, readPendingInvite, storePendingInvite, clearPendingInvite, PENDING_INVITE_KEY,
  acceptStepFor, ACCEPT_STEP, passwordProblem, PASSWORD_MIN,
  membershipGate, GATE, inviteStatusBadge, deliveryBadge, memberStatusBadge, canEditMember, fileLinkNote, FILE_LINK_STATUS,
  teamErrorMessage, teamErrorCode, authErrorMessage,
} from '../../src/lib/team.js'

// ── lib/team.js — pure helpers for team management (ADR-72) ─────────────────

const TOKEN = 'A'.repeat(43)

describe('roles', () => {
  it('exactly the three internal roles are offered; only company_admin manages', () => {
    expect(TEAM_ROLE_VALUES).toEqual(['company_admin', 'project_manager', 'qs'])
    expect(TEAM_ROLES.every(r => r.label && r.hint)).toBe(true)
    for (const r of ['super_admin', 'subcontractor', 'client', 'owner', undefined]) expect(isTeamRole(r)).toBe(false)
    expect(canManageTeam('company_admin')).toBe(true)
    expect(canManageTeam('project_manager')).toBe(false)
    expect(canManageTeam('super_admin')).toBe(false)
  })
})

describe('invitation link fragment', () => {
  it('parses a well-formed fragment and rejects anything else', () => {
    expect(parseInviteFragment(`#c=co_1&i=inv-2&t=${TOKEN}`)).toEqual({ companyId: 'co_1', inviteId: 'inv-2', token: TOKEN })
    expect(parseInviteFragment(`c=co_1&i=inv-2&t=${TOKEN}`)).toEqual({ companyId: 'co_1', inviteId: 'inv-2', token: TOKEN })
    expect(parseInviteFragment('')).toBe(null)
    expect(parseInviteFragment('#')).toBe(null)
    expect(parseInviteFragment(`#c=co&i=inv&t=short`)).toBe(null)
    expect(parseInviteFragment(`#c=../x&i=inv&t=${TOKEN}`)).toBe(null)
    expect(parseInviteFragment(null)).toBe(null)
    expect(isInviteCredential({ companyId: 'a', inviteId: 'b', token: TOKEN })).toBe(true)
    expect(isInviteCredential({ companyId: 'a', inviteId: 'b', token: TOKEN + 'x' })).toBe(false)
  })

  it('round-trips through sessionStorage and degrades to null when storage is unavailable', () => {
    const store = new Map()
    const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) }
    const cred = { companyId: 'a', inviteId: 'b', token: TOKEN }
    expect(storePendingInvite(storage, cred)).toBe(true)
    expect(store.has(PENDING_INVITE_KEY)).toBe(true)
    expect(readPendingInvite(storage)).toEqual(cred)
    clearPendingInvite(storage)
    expect(readPendingInvite(storage)).toBe(null)
    expect(storePendingInvite(storage, { companyId: 'a' })).toBe(false)
    const broken = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') }, removeItem: () => { throw new Error('blocked') } }
    expect(readPendingInvite(broken)).toBe(null)
    expect(storePendingInvite(broken, cred)).toBe(false)
    expect(() => clearPendingInvite(broken)).not.toThrow()
    expect(readPendingInvite(null)).toBe(null)
    storage.setItem(PENDING_INVITE_KEY, '{not json')
    expect(readPendingInvite(storage)).toBe(null)
  })
})

describe('accept flow', () => {
  const p = (accountState, email = 'jo@x.test') => ({ accountState, email })
  it('chooses the step from the preview and the signed-in email', () => {
    expect(acceptStepFor(p('new'), null)).toBe(ACCEPT_STEP.REGISTER)
    expect(acceptStepFor(p('existing'), null)).toBe(ACCEPT_STEP.SIGN_IN)
    expect(acceptStepFor(p('reactivated'), null)).toBe(ACCEPT_STEP.REACTIVATED)
    expect(acceptStepFor(p('already-member'), null)).toBe(ACCEPT_STEP.ALREADY_MEMBER)
    expect(acceptStepFor(p('other-company'), null)).toBe(ACCEPT_STEP.OTHER_COMPANY)
    expect(acceptStepFor(p('blocked'), 'jo@x.test')).toBe(ACCEPT_STEP.BLOCKED)
    expect(acceptStepFor(p('existing'), 'jo@x.test')).toBe(ACCEPT_STEP.ACCEPT)
    expect(acceptStepFor(p('new'), 'jo@x.test')).toBe(ACCEPT_STEP.ACCEPT)
    expect(acceptStepFor(p('already-member'), 'jo@x.test')).toBe(ACCEPT_STEP.ALREADY_MEMBER)
    expect(acceptStepFor(p('existing'), 'someone@else.test')).toBe(ACCEPT_STEP.SWITCH_ACCOUNT)
    expect(acceptStepFor(p('existing', 'Jo@X.test'), 'jo@x.test')).toBe(ACCEPT_STEP.ACCEPT)
    expect(acceptStepFor(null, null)).toBe(null)
  })
  it('password rule mirrors the documented minimum', () => {
    expect(PASSWORD_MIN).toBe(12)
    expect(passwordProblem('short', 'short')).toContain('12')
    expect(passwordProblem('long-enough-pw', 'different')).toBe('The passwords do not match.')
    expect(passwordProblem('long-enough-pw', 'long-enough-pw')).toBe(null)
    expect(passwordProblem('long-enough-pw')).toBe(null)
    expect(passwordProblem('x'.repeat(129), 'x'.repeat(129))).toContain('128')
  })
})

describe('membership gate', () => {
  it('loading → error → none → deactivated → active, with legacy profiles active', () => {
    expect(membershipGate({ profile: null, profileLoading: true, profileError: false })).toBe(GATE.LOADING)
    expect(membershipGate({ profile: null, profileLoading: false, profileError: true })).toBe(GATE.ERROR)
    expect(membershipGate({ profile: null, profileLoading: false, profileError: false })).toBe(GATE.NONE)
    expect(membershipGate({ profile: { companyId: null, status: 'deactivated' }, profileLoading: false, profileError: false })).toBe(GATE.DEACTIVATED)
    expect(membershipGate({ profile: { companyId: null }, profileLoading: false, profileError: false })).toBe(GATE.NONE)
    expect(membershipGate({ profile: { companyId: '' }, profileLoading: false, profileError: false })).toBe(GATE.NONE)
    expect(membershipGate({ profile: { companyId: 'c', role: 'qs' }, profileLoading: false, profileError: false })).toBe(GATE.ACTIVE)
    expect(membershipGate({ profile: { companyId: 'c', role: 'qs', status: 'active' }, profileLoading: false, profileError: false })).toBe(GATE.ACTIVE)
  })
})

describe('presentation', () => {
  it('badges and editability', () => {
    expect(inviteStatusBadge('pending')).toEqual({ label: 'Pending', variant: 'pending' })
    expect(inviteStatusBadge('locked').variant).toBe('danger')
    expect(inviteStatusBadge('weird').label).toBe('weird')
    expect(deliveryBadge('failed')).toEqual({ label: 'Not delivered', variant: 'danger' })
    expect(memberStatusBadge({ status: 'active' })).toEqual({ label: 'Active', variant: 'active' })
    expect(memberStatusBadge({ status: 'deactivated', authSyncPending: true }).label).toContain('sync pending')
    const base = { status: 'active', managed: 'team', isSelf: false, role: 'qs' }
    expect(canEditMember(base)).toBe(true)
    expect(canEditMember({ ...base, isSelf: true })).toBe(false)
    expect(canEditMember({ ...base, managed: 'operator', role: 'client' })).toBe(false)
    expect(canEditMember({ ...base, status: 'deactivated' })).toBe(false)
    expect(canEditMember(null)).toBe(false)
  })
})

describe('errors', () => {
  it('maps backend codes to copy and collapses auth enumeration', () => {
    expect(teamErrorCode({ details: { code: 'last-admin' } })).toBe('last-admin')
    expect(teamErrorMessage({ details: { code: 'last-admin' } })).toContain('at least one active Company Admin')
    expect(teamErrorMessage({ code: 'functions/unauthenticated' })).toBe('Sign in to continue.')
    expect(teamErrorMessage({ code: 'functions/internal' })).toBe('Something went wrong. Please try again.')
    expect(teamErrorMessage(null, 'fallback')).toBe('fallback')
    expect(authErrorMessage('auth/user-not-found')).toBe(authErrorMessage('auth/wrong-password'))
    expect(authErrorMessage('auth/invalid-credential')).toBe('Incorrect email or password.')
    expect(authErrorMessage('auth/email-already-in-use')).toContain('Sign in instead')
    expect(authErrorMessage('auth/nope')).toBe('That did not work. Please try again.')
  })
})

// ── Old file links (ADR-74, DC46-B) ─────────────────────────────────────────
describe('file-link revocation note', () => {
  const note = (fileLinks) => fileLinkNote({ status: 'deactivated', fileLinks })

  it('shows nothing when the backend reports nothing', () => {
    expect(fileLinkNote(null)).toBe(null)
    expect(fileLinkNote({ status: 'active' })).toBe(null)
    expect(fileLinkNote({ status: 'active', fileLinks: null })).toBe(null)
    expect(note({ status: 'something-new' })).toBe(null)
  })

  it('uses exactly the approved wording for the three states', () => {
    expect(note({ status: FILE_LINK_STATUS.PENDING })).toEqual({ text: 'Old file links: revocation pending', tone: 'pending' })
    expect(note({ status: FILE_LINK_STATUS.REVOKED })).toEqual({ text: 'Old file links: revoked', tone: 'muted' })
    expect(note({ status: FILE_LINK_STATUS.DELAYED })).toEqual({ text: 'Revocation delayed: retrying', tone: 'warning' })
  })

  it('names the outstanding files when the backend counts them', () => {
    expect(note({ status: 'delayed', outstanding: 1 }).text).toBe('Revocation delayed: retrying (1 file outstanding)')
    expect(note({ status: 'delayed', outstanding: 12 }).text).toBe('Revocation delayed: retrying (12 files outstanding)')
    expect(note({ status: 'delayed', outstanding: 0 }).text).toBe('Revocation delayed: retrying')
  })

  it('a member removed before this feature is "not yet revoked", never "revoked"', () => {
    expect(note({ status: FILE_LINK_STATUS.NOT_REQUESTED })).toEqual({ text: 'Old file links: not yet revoked', tone: 'warning' })
  })

  it('never claims immediacy and mirrors the backend status values', () => {
    for (const status of Object.values(FILE_LINK_STATUS)) {
      expect(note({ status }).text).not.toMatch(/immediate|instant|at once|straight away/i)
    }
    expect(FILE_LINK_STATUS).toEqual({ PENDING: 'pending', REVOKED: 'revoked', DELAYED: 'delayed', NOT_REQUESTED: 'not_requested' })
  })
})
