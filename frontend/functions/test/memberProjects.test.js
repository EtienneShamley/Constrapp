import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  checkProjectIds, invitationAssignment, currentAssignment, resolveAssignmentChange, ASSIGNMENT_PROBLEM,
  EXTERNAL_ROLES, INTERNAL_ROLES, OPERATOR_ROLES, MAX_PROJECT_ASSIGNMENTS, isExternalRole,
  parseCreateInvitation, parseAcceptInvitation, parseChangeMemberRole, parseMemberUid,
} from '../src/lib/validation.js'
import { CODE, isTeamError, TeamError } from '../src/lib/errors.js'
import { AUDIT } from '../src/lib/audit.js'
import { REASON } from '../src/lib/fileLinkRevocation.js'
import { renderInviteEmail } from '../src/lib/email.js'
import { HANDLER_NAMES } from '../src/team/handlers.js'
import { ID_LIST_PATTERN, parseIdList, describeRefusal } from '../scripts/_cli.mjs'

// ── M2-A2 Stage B (ADR-84) — pure checks and structural pins ────────────────
// No emulator. The transactions are covered by
// frontend/tests/functions/team.externalProvisioning.test.js.

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1')
const ids = (n, prefix = 'p') => Array.from({ length: n }, (_, i) => `${prefix}${String(i).padStart(2, '0')}`)
const code = (fn, expected) => {
  try { fn() } catch (e) { expect(isTeamError(e, expected), `expected ${expected}, got ${e?.details?.code ?? e}`).toBe(true); return }
  throw new Error(`expected ${expected} to be thrown`)
}

describe('roles', () => {
  it('exactly two external roles, disjoint from the internal three; super_admin is neither', () => {
    expect(EXTERNAL_ROLES).toEqual(['client', 'subcontractor'])
    expect(EXTERNAL_ROLES.filter(r => INTERNAL_ROLES.includes(r))).toEqual([])
    expect(EXTERNAL_ROLES.every(r => OPERATOR_ROLES.includes(r))).toBe(true)
    for (const r of ['super_admin', 'company_admin', 'project_manager', 'qs', 'Client', '', null, undefined, 'owner']) expect(isExternalRole(r), String(r)).toBe(false)
    expect(MAX_PROJECT_ASSIGNMENTS).toBe(30)
  })
})

describe('checkProjectIds', () => {
  it('accepts 1–30 unique valid ids and returns a NEW sorted list', () => {
    const input = ['b', 'a', 'C_1-x']
    const r = checkProjectIds(input)
    expect(r).toEqual({ ok: true, projectIds: ['C_1-x', 'a', 'b'] })
    expect(input).toEqual(['b', 'a', 'C_1-x'])
    expect(checkProjectIds(ids(30)).ok).toBe(true)
  })

  it('refuses missing, malformed, empty, too many and duplicate — and repairs nothing', () => {
    expect(checkProjectIds(undefined)).toEqual({ ok: false, reason: ASSIGNMENT_PROBLEM.MISSING })
    expect(checkProjectIds(null)).toEqual({ ok: false, reason: ASSIGNMENT_PROBLEM.MISSING })
    for (const bad of ['p1', 7, {}, { 0: 'p1', length: 1 }, new Set(['p1'])]) expect(checkProjectIds(bad).reason, String(bad)).toBe(ASSIGNMENT_PROBLEM.MALFORMED)
    for (const bad of [[''], ['a/b'], ['a b'], [1], [null], [['a']], [{ id: 'a' }], ['a'.repeat(65)], ['ok', '../x'], ['companies/x/projects/y']]) {
      expect(checkProjectIds(bad).reason, JSON.stringify(bad)).toBe(ASSIGNMENT_PROBLEM.MALFORMED)
    }
    expect(checkProjectIds([])).toEqual({ ok: false, reason: ASSIGNMENT_PROBLEM.EMPTY })
    expect(checkProjectIds(ids(31))).toEqual({ ok: false, reason: ASSIGNMENT_PROBLEM.TOO_MANY })
    expect(checkProjectIds(['a', 'b', 'a'])).toEqual({ ok: false, reason: ASSIGNMENT_PROBLEM.DUPLICATE, projectId: 'a' })
    // Ids differing only in case are different Firestore documents.
    expect(checkProjectIds(['a', 'A']).ok).toBe(true)
    expect(checkProjectIds([], { min: 0 })).toEqual({ ok: true, projectIds: [] })
  })
})

describe('invitationAssignment', () => {
  it('an external role REQUIRES a sound assignment', () => {
    for (const role of EXTERNAL_ROLES) {
      expect(invitationAssignment(role, ['p2', 'p1'])).toEqual({ ok: true, external: true, projectIds: ['p1', 'p2'] })
      expect(invitationAssignment(role, undefined).reason).toBe(ASSIGNMENT_PROBLEM.MISSING)
      expect(invitationAssignment(role, null).reason).toBe(ASSIGNMENT_PROBLEM.MISSING)
      expect(invitationAssignment(role, []).reason).toBe(ASSIGNMENT_PROBLEM.EMPTY)
      expect(invitationAssignment(role, ids(31)).reason).toBe(ASSIGNMENT_PROBLEM.TOO_MANY)
      expect(invitationAssignment(role, ['p1', 'p1']).reason).toBe(ASSIGNMENT_PROBLEM.DUPLICATE)
      expect(invitationAssignment(role, 'p1').reason).toBe(ASSIGNMENT_PROBLEM.MALFORMED)
    }
  })

  it('an internal role carries NO assignment — any list, even an empty one, is refused', () => {
    for (const role of INTERNAL_ROLES) {
      expect(invitationAssignment(role, undefined)).toEqual({ ok: true, external: false, projectIds: null })
      expect(invitationAssignment(role, null)).toEqual({ ok: true, external: false, projectIds: null })
      for (const carried of [['p1'], [], 'p1', {}]) expect(invitationAssignment(role, carried)).toEqual({ ok: false, reason: ASSIGNMENT_PROBLEM.ROLE })
    }
  })

  it('every other role is refused, with or without an assignment', () => {
    for (const role of ['super_admin', 'owner', '', null, undefined, 7, 'CLIENT']) {
      expect(invitationAssignment(role, undefined), String(role)).toEqual({ ok: false, reason: ASSIGNMENT_PROBLEM.ROLE })
      expect(invitationAssignment(role, ['p1']), String(role)).toEqual({ ok: false, reason: ASSIGNMENT_PROBLEM.ROLE })
    }
  })
})

describe('currentAssignment', () => {
  it('reads a stored value the way the Rules do: only a list grants anything', () => {
    expect(currentAssignment(undefined)).toEqual({ projectIds: [], sound: true })
    expect(currentAssignment(null)).toEqual({ projectIds: [], sound: true })
    expect(currentAssignment(['a', 'b'])).toEqual({ projectIds: ['a', 'b'], sound: true })
    expect(currentAssignment(['b', 'a'])).toEqual({ projectIds: ['a', 'b'], sound: false })
    expect(currentAssignment(['a', 'a'])).toEqual({ projectIds: ['a'], sound: false })
    expect(currentAssignment(['a', 7, null, 'x/y'])).toEqual({ projectIds: ['a'], sound: false })
    for (const bad of ['p1', 7, { a: 1 }, true]) expect(currentAssignment(bad), String(bad)).toEqual({ projectIds: [], sound: false })
  })
})

describe('resolveAssignmentChange', () => {
  it('set replaces the list; an empty set removes everything', () => {
    expect(resolveAssignmentChange(['a', 'b'], { set: ['c', 'b'] })).toEqual({ ok: true, projectIds: ['b', 'c'], added: ['c'], removed: ['a'] })
    expect(resolveAssignmentChange(['a', 'b'], { set: [] })).toEqual({ ok: true, projectIds: [], added: [], removed: ['a', 'b'] })
    expect(resolveAssignmentChange(['a'], { set: ['a'] })).toEqual({ ok: true, projectIds: ['a'], added: [], removed: [] })
    expect(resolveAssignmentChange([], { set: ids(31) }).reason).toBe(ASSIGNMENT_PROBLEM.TOO_MANY)
    expect(resolveAssignmentChange([], { set: ['a', 'a'] }).reason).toBe(ASSIGNMENT_PROBLEM.DUPLICATE)
    expect(resolveAssignmentChange([], { set: 'a' }).reason).toBe(ASSIGNMENT_PROBLEM.MALFORMED)
  })

  it('add / remove resolve against the CURRENT list and are safe to repeat', () => {
    expect(resolveAssignmentChange(['a'], { add: ['b'] })).toEqual({ ok: true, projectIds: ['a', 'b'], added: ['b'], removed: [] })
    expect(resolveAssignmentChange(['a', 'b'], { add: ['b'] })).toEqual({ ok: true, projectIds: ['a', 'b'], added: [], removed: [] })
    expect(resolveAssignmentChange(['a', 'b'], { remove: ['b'] })).toEqual({ ok: true, projectIds: ['a'], added: [], removed: ['b'] })
    expect(resolveAssignmentChange(['a'], { remove: ['b'] })).toEqual({ ok: true, projectIds: ['a'], added: [], removed: [] })
    expect(resolveAssignmentChange(['a', 'b'], { add: ['c'], remove: ['a'] })).toEqual({ ok: true, projectIds: ['b', 'c'], added: ['c'], removed: ['a'] })
  })

  it('refuses an over-full result, a clash, an empty or an ambiguous request', () => {
    expect(resolveAssignmentChange(ids(30), { add: ['extra'] }).reason).toBe(ASSIGNMENT_PROBLEM.TOO_MANY)
    expect(resolveAssignmentChange(ids(30), { add: ['extra'], remove: ['p00'] }).ok).toBe(true)
    expect(resolveAssignmentChange(['a'], { add: ['b'], remove: ['b'] })).toEqual({ ok: false, reason: ASSIGNMENT_PROBLEM.CONFLICT, projectId: 'b' })
    expect(resolveAssignmentChange(['a'], { add: [], remove: [] }).reason).toBe(ASSIGNMENT_PROBLEM.EMPTY)
    for (const bad of [undefined, null, {}, { set: ['a'], add: ['b'] }, { set: ['a'], remove: ['b'] }]) {
      expect(resolveAssignmentChange(['a'], bad).reason, JSON.stringify(bad)).toBe(ASSIGNMENT_PROBLEM.MALFORMED)
    }
    expect(resolveAssignmentChange(['a'], { add: ['b', 'b'] }).reason).toBe(ASSIGNMENT_PROBLEM.DUPLICATE)
    expect(resolveAssignmentChange(['a'], { remove: ['x/y'] }).reason).toBe(ASSIGNMENT_PROBLEM.MALFORMED)
  })
})

describe('no callable accepts an assignment from a browser', () => {
  it('every team schema refuses a projectIds key, and the invitation schema still refuses an external role', () => {
    code(() => parseCreateInvitation({ email: 'a@b.co', role: 'qs', projectIds: ['p1'] }), CODE.INVALID_ARGUMENT)
    code(() => parseCreateInvitation({ email: 'a@b.co', role: 'client' }), CODE.INVALID_ROLE)
    code(() => parseCreateInvitation({ email: 'a@b.co', role: 'subcontractor' }), CODE.INVALID_ROLE)
    const cred = { companyId: 'c', inviteId: 'i', token: 'A'.repeat(43) }
    expect(parseAcceptInvitation({ ...cred, name: 'Ada' })).toEqual({ ...cred, name: 'Ada' })
    code(() => parseAcceptInvitation({ ...cred, projectIds: ['p1'] }), CODE.INVALID_ARGUMENT)
    code(() => parseAcceptInvitation({ ...cred, role: 'client' }), CODE.INVALID_ARGUMENT)
    code(() => parseChangeMemberRole({ uid: 'u', role: 'qs', expectedRole: 'qs', projectIds: ['p1'] }), CODE.INVALID_ARGUMENT)
    code(() => parseMemberUid({ uid: 'u', projectIds: [] }), CODE.INVALID_ARGUMENT)
  })

  it('assignment management is NOT a callable: still eight handlers, and neither the handlers nor index.js reach the operator library', () => {
    expect(HANDLER_NAMES).toHaveLength(8)
    for (const f of ['src/team/handlers.js', 'src/index.js', 'src/finalAccount/handlers.js', 'src/boqBudget/handlers.js']) {
      const src = stripComments(read(f))
      expect(src, f).not.toMatch(/memberProjects|setMemberProjects|provisionExternalMember|projectIds/)
    }
    // The library itself is imported by the two operator scripts only.
    const walk = (dir) => readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap(e =>
      e.isDirectory() ? walk(join(dir, e.name)) : /\.m?js$/.test(e.name) ? [join(dir, e.name)] : [])
    const importers = [...walk('src'), ...walk('scripts')].filter(f => /lib\/memberProjects\.js|\.\/memberProjects\.js/.test(stripComments(read(f))))
    expect(importers.sort()).toEqual(['scripts/provision-external-member.mjs', 'scripts/set-member-projects.mjs'])
  })

  it('only five source files mention projectIds at all, and exactly three write it to users/{uid}', () => {
    const src = readdirSync(join(ROOT, 'src/lib')).filter(f => /projectIds/.test(stripComments(read(`src/lib/${f}`)))).sort()
    expect(src).toEqual(['invitations.js', 'memberProjects.js', 'members.js', 'projectAssignments.js', 'validation.js'])
    // projectAssignments.js only READS project documents; it writes nothing.
    expect(stripComments(read('src/lib/projectAssignments.js'))).not.toMatch(/\.(set|update|create|delete)\(/)
    // Acceptance sets or removes it; deactivation removes it; the operator change replaces it.
    expect(stripComments(read('src/lib/invitations.js'))).toContain('projectIds: assignment.external ? assignment.projectIds : FieldValue.delete(),')
    expect(stripComments(read('src/lib/members.js'))).toContain('projectIds: FieldValue.delete(),')
    expect(stripComments(read('src/lib/memberProjects.js'))).toContain('tx.update(userRef(db, uid), { projectIds: result.after, updatedAt: ts, updatedBy: actor.uid })')
    // Role change never grants one (its schema allows internal roles only).
    const roleChange = read('src/lib/members.js').split('export async function changeMemberRole')[1].split('export async function deactivateMember')[0]
    expect(roleChange).not.toMatch(/projectIds/)
  })
})

describe('vocabulary', () => {
  it('one new audit type, one new revocation reason, one new operator error code', () => {
    expect(AUDIT.MEMBER_PROJECTS_CHANGED).toBe('member.projects_changed')
    expect(REASON.ASSIGNMENT_REMOVED).toBe('member.assignment_removed')
    expect(Object.values(REASON).sort()).toEqual(['member.assignment_removed', 'member.deactivated', 'member.role_reduced', 'operator', 'periodic'])
    const e = new TeamError(CODE.INVALID_ASSIGNMENT, { reason: 'duplicate' })
    expect(e.code).toBe('failed-precondition')
    expect(e.details).toEqual({ code: 'invalid-assignment', reason: 'duplicate' })
  })

  it('the invitation email names the two external roles', () => {
    for (const [role, label] of [['client', 'Client'], ['subcontractor', 'Subcontractor'], ['qs', 'Quantity Surveyor']]) {
      const r = renderInviteEmail({ companyName: 'Acme', inviterName: null, role, link: 'https://x/accept-invite#t', expiresAt: new Date('2026-12-01T00:00:00Z') })
      expect(r.text).toContain(`as ${label}.`)
    }
  })
})

describe('operator scripts — source pins', () => {
  const PROVISION = read('scripts/provision-external-member.mjs')
  const SET = read('scripts/set-member-projects.mjs')

  it('both are dry-run by default: a write needs the explicit --apply flag', () => {
    expect(PROVISION).toMatch(/const apply = !!args\.apply/)
    expect(PROVISION).toContain('provisionExternalMember(deps, { ...request, dryRun: true })')
    expect(PROVISION).toContain('provisionExternalMember(deps, { ...request, dryRun: false })')
    expect(PROVISION.indexOf("if (!apply) {")).toBeLessThan(PROVISION.indexOf('dryRun: false'))
    // The assignment script ALWAYS runs the read-only pass first; the write
    // comes after the `if (!apply)` return.
    expect(SET).toContain('setMemberProjects(deps, { companyId, uid, change, dryRun: true })')
    expect(SET).toContain('setMemberProjects(deps, { companyId, uid, change, dryRun: false })')
    expect(SET.indexOf('dryRun: true')).toBeLessThan(SET.indexOf('if (!apply) {'))
    expect(SET.indexOf('if (!apply) {')).toBeLessThan(SET.indexOf('dryRun: false'))
    // A refusal must let the SDK's un-awaited rollback go out before the process ends.
    for (const s of [PROVISION, SET]) expect(s.slice(s.indexOf('main().catch'))).not.toMatch(/process\.exit\(/)
    for (const s of [PROVISION, SET]) {
      expect(s).toMatch(/'project':\s+\{ required: true/)
      expect(s).toContain('configureProject(args.project)')
      expect(s).not.toMatch(/serviceAccount|cert\(|GOOGLE_APPLICATION_CREDENTIALS|\.json'/)
    }
  })

  it('the acceptance link reaches a private file and nothing else — never the console', () => {
    const code = stripComments(PROVISION)
    const linkUses = code.split('\n').filter(l => /\.link\b/.test(l)).map(l => l.trim())
    expect(linkUses).toEqual(['if (fd !== null) writeSync(fd, `${done.link}\\n`)'])
    expect(code).toContain("openSync(linkFile, 'wx', 0o600)")
    expect(code).not.toMatch(/console\.(log|error|warn)\([^)]*(link|token|done)\b/)
    expect(code).not.toMatch(/log\.(info|warn|error)\([^\n]*\bdone\.link/)
    expect(code).not.toMatch(/password|createUser|generatePasswordResetLink|generateSignInWithEmailLink|createCustomToken/i)
    expect(stripComments(SET)).not.toMatch(/password|createUser|accept-invite|generateToken|buildInviteLink|createInvitation/i)
  })

  it('id lists are comma-separated ids and nothing else', () => {
    for (const ok of ['a', 'a,b', 'Iusni6U8enVn47fKBGDB,3OyBieoY4QHAfQsxBH8T']) expect(ID_LIST_PATTERN.test(ok), ok).toBe(true)
    for (const bad of ['', ',', 'a,', ',a', 'a,,b', 'a b', 'a/b', 'a, b', '*']) expect(ID_LIST_PATTERN.test(bad), bad).toBe(false)
    expect(parseIdList('a,b')).toEqual(['a', 'b'])
    expect(parseIdList(undefined)).toBeUndefined()
  })

  it('a refusal is described by its code and ids only', () => {
    expect(describeRefusal(new TeamError(CODE.INVALID_ASSIGNMENT, { reason: 'project-not-found', projectIds: ['p9'] }))).toBe('invalid-assignment — project-not-found · project id(s): p9')
    expect(describeRefusal(new TeamError(CODE.ALREADY_MEMBER))).toBe('already-member')
    expect(describeRefusal(new Error('boom'))).toBeNull()
  })
})
