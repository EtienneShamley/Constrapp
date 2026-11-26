import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createFinalAccountHandlers, parseApproveFinalAccount, FINAL_ACCOUNT_HANDLER_NAMES } from '../src/finalAccount/handlers.js'
import { assertActiveRole } from '../src/lib/authz.js'
import { CODE, isTeamError } from '../src/lib/errors.js'
import { AUDIT } from '../src/lib/audit.js'
import * as calc from '../src/generated/finalAccountCalc.js'

// ── approveFinalAccount — pins that need no Firestore (ADR-77) ───────────────
//
// The emulator-backed behaviour (transactions, races, figures) lives in
// frontend/tests/functions/finalAccount.approve.test.js; the freshness and
// client/server equality of the generated calculation in
// frontend/tests/unit/finalAccountBundle.test.js. This file runs in the
// Functions PREDEPLOY chain, so a deploy cannot ship a broken gate or a
// generated file that is missing or not self-contained.

const src = (rel) => readFileSync(fileURLToPath(new URL(`../src/${rel}`, import.meta.url)), 'utf8')
const deps = (over = {}) => ({ db: null, now: () => new Date('2026-11-19T00:00:00Z'), log: { info() {}, warn() {}, error() {} }, config: () => ({ enabled: true }), ...over })
const refused = async (promise, code) => {
  try { await promise } catch (e) { expect(isTeamError(e, code), `${e?.details?.code ?? e?.message}`).toBe(true); return }
  throw new Error('no throw')
}

describe('handler gates before any data access', () => {
  it('exactly one handler', () => {
    expect(FINAL_ACCOUNT_HANDLER_NAMES).toEqual(['approveFinalAccount'])
    expect(typeof createFinalAccountHandlers(deps()).approveFinalAccount).toBe('function')
  })
  it('the kill switch answers first; then authentication; then validation — db is never touched (it is null)', async () => {
    const off = createFinalAccountHandlers(deps({ config: () => ({ enabled: false }) }))
    await refused(off.approveFinalAccount({ auth: { uid: 'u' }, data: {} }), CODE.FINAL_ACCOUNT_DISABLED)
    const h = createFinalAccountHandlers(deps())
    await refused(h.approveFinalAccount({ auth: null, data: { nonsense: true } }), CODE.UNAUTHENTICATED)
    await refused(h.approveFinalAccount({ auth: { uid: 'u' }, data: { projectId: 'p', number: 1, expectedRevision: 1, acknowledged: true, total: 5 } }), CODE.INVALID_ARGUMENT)
  })
})

describe('request schema — identifiers and guards only', () => {
  const ok = { projectId: 'projectA', number: 1, expectedRevision: 1, acknowledged: true }
  it('accepts the exact shape and returns no acknowledgement or amount onward', () => {
    expect(parseApproveFinalAccount(ok)).toEqual({ projectId: 'projectA', number: 1, expectedRevision: 1 })
  })
  it.each([
    ['an extra amount key', { ...ok, figures: {} }],
    ['a companyId', { ...ok, companyId: 'c' }],
    ['a missing key', { projectId: 'p', number: 1, expectedRevision: 1 }],
    ['acknowledged false', { ...ok, acknowledged: false }],
    ['acknowledged "true"', { ...ok, acknowledged: 'true' }],
    ['number as a string', { ...ok, number: '1' }],
    ['number 0', { ...ok, number: 0 }],
    ['number 10000', { ...ok, number: 10000 }],
    ['expectedRevision 0', { ...ok, expectedRevision: 0 }],
    ['a path in projectId', { ...ok, projectId: 'a/b' }],
    ['an empty projectId', { ...ok, projectId: '' }],
    ['null', null], ['a string', 'x'], ['an array', [ok]],
  ])('refuses %s', (_label, data) => {
    try { parseApproveFinalAccount(data); throw new Error('no throw') } catch (e) { expect(isTeamError(e, CODE.INVALID_ARGUMENT)).toBe(true) }
  })
})

describe('approver membership', () => {
  const roles = calc.FINAL_ACCOUNT_APPROVE_ROLES
  const check = (profile) => { try { assertActiveRole(profile, roles, CODE.NOT_APPROVER); return 'ok' } catch (e) { return e.details.code } }
  it('only an ACTIVE company_admin or project_manager of a company passes', () => {
    expect(roles).toEqual(['company_admin', 'project_manager'])
    expect(check({ role: 'company_admin', companyId: 'c', status: 'active' })).toBe('ok')
    expect(check({ role: 'project_manager', companyId: 'c' })).toBe('ok')           // legacy profile, no status
    for (const role of ['qs', 'subcontractor', 'client', 'super_admin', undefined]) expect(check({ role, companyId: 'c' })).toBe(CODE.NOT_APPROVER)
    expect(check(null)).toBe(CODE.NO_MEMBERSHIP)
    expect(check({ role: 'company_admin', companyId: null })).toBe(CODE.NO_MEMBERSHIP)
    expect(check({ role: 'company_admin', companyId: 'c', status: 'deactivated' })).toBe(CODE.MEMBERSHIP_INACTIVE)
  })
})

describe('the generated calculation shipped with the function', () => {
  const bundle = src('generated/finalAccountCalc.js')
  it('is present, marked generated, and imports nothing', () => {
    expect(bundle.startsWith('// GENERATED FILE — DO NOT EDIT.')).toBe(true)
    const code = bundle.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
    expect(code).not.toMatch(/^\s*import\s/m)
    expect(code).not.toMatch(/\brequire\(|\bimport\(|import\.meta|\bwindow\.|\bdocument\./)
  })
  it('exports the functions the operation calls', () => {
    for (const name of ['computeFinalAccount', 'settledSourceStates', 'draftAgreesWith', 'finalAccountContent', 'blockerCodes', 'estimateFinalAccountBytes', 'resolveProjectCurrency']) {
      expect(typeof calc[name], name).toBe('function')
    }
    expect(calc.FINAL_ACCOUNT_STATUS).toEqual({ DRAFT: 'draft', APPROVED: 'approved', WITHDRAWN: 'withdrawn' })
  })
  it('an empty project is NOT ready and yields no figure set (never zeros)', () => {
    const c = calc.computeFinalAccount({ project: { id: 'p' }, currencyCode: 'AUD', sources: {}, sourceStates: calc.settledSourceStates() })
    expect(c.ready).toBe(false)
    expect(calc.blockerCodes(c)).toEqual(expect.arrayContaining(['contract', 'budget']))
    expect(c.figures).toBeNull()
  })
})

describe('surface', () => {
  const index = src('index.js')
  const approve = src('finalAccount/approve.js')
  it('one more callable, App Check enforced, no secret, its own kill switch; the worker and team callables untouched', () => {
    expect(index).toContain('export const approveFinalAccount = onCall(FINAL_ACCOUNT_CALL_OPTIONS')
    const opts = index.slice(index.indexOf('export const FINAL_ACCOUNT_CALL_OPTIONS'), index.indexOf('let finalAccountHandlers'))
    expect(opts).toMatch(/enforceAppCheck:\s*true/)
    expect(opts).toMatch(/region:\s*REGION/)
    expect(opts).not.toMatch(/secrets|serviceAccount/)
    expect(index).toContain('FINAL_ACCOUNT_APPROVAL_ENABLED.value()')
    expect((index.match(/wrap\('/g) || []).length).toBe(8)
    expect((index.match(/onSchedule\(/g) || []).length).toBe(1)
  })
  it('the operation is one transaction with a bounded retry, writes one audit type, and stamps server time', () => {
    expect((approve.match(/db\.runTransaction\(/g) || []).length).toBe(1)
    expect(approve).toContain('{ maxAttempts: APPROVAL_MAX_ATTEMPTS }')
    expect(approve).toContain('export const APPROVAL_MAX_ATTEMPTS = 5')
    expect(approve).toContain('AUDIT.FINAL_ACCOUNT_APPROVED')
    expect(AUDIT.FINAL_ACCOUNT_APPROVED).toBe('final_account.approved')
    expect(approve).toContain('approvedAt: FieldValue.serverTimestamp()')
    expect(approve).toContain('{ lastUpdateTime: accountSnap.updateTime }')
    expect((approve.match(/tx\.(update|set|create|delete)\(/g) || []).length).toBe(1)   // + auditInTx
  })
})

describe('release safety', () => {
  const DIR = fileURLToPath(new URL('../', import.meta.url))
  const envFiles = readdirSync(DIR).filter(f => /^\.env\.[a-z0-9-]+$/.test(f) && f !== '.env.local')
  const valueOf = (file, key) => readFileSync(join(DIR, file), 'utf8').split('\n').find(l => l.startsWith(`${key}=`))?.slice(key.length + 1)

  it('the feature flag DEFAULTS TO OFF in code (fail closed) and every project env file states it explicitly', () => {
    expect(src('lib/params.js')).toContain("export const FINAL_ACCOUNT_APPROVAL_ENABLED = defineBoolean('FINAL_ACCOUNT_APPROVAL_ENABLED', { default: false })")
    expect(envFiles).toEqual(expect.arrayContaining(['.env.constrapp-69b5d', '.env.constrapp-rules-test']))
    // A non-interactive deploy refuses a parameter with no dotenv value, so the
    // key must be PRESENT in every project file, with a boolean value.
    for (const f of envFiles) expect(['true', 'false'], f).toContain(valueOf(f, 'FINAL_ACCOUNT_APPROVAL_ENABLED'))
    expect(valueOf('.env.constrapp-69b5d', 'FINAL_ACCOUNT_APPROVAL_ENABLED')).toBe('true')
  })

  it('adding the flag changed no existing production parameter', () => {
    expect(valueOf('.env.constrapp-69b5d', 'TEAM_MANAGEMENT_ENABLED')).toBe('true')
    expect(valueOf('.env.constrapp-69b5d', 'FILE_LINK_REVOCATION_ENABLED')).toBe('true')
    expect(valueOf('.env.constrapp-69b5d', 'FILE_LINK_RECONCILE_INTERVAL_HOURS')).toBe('2')
    expect(valueOf('.env.constrapp-69b5d', 'STORAGE_BUCKET')).toBe('')
  })

  it('the function is exported under the exact name the deploy filter names, in the `team` codebase', () => {
    const index = src('index.js')
    expect(index.match(/^export const approveFinalAccount = onCall\(/m)).not.toBeNull()
    const firebaseJson = JSON.parse(readFileSync(join(DIR, '../firebase.json'), 'utf8'))
    expect(firebaseJson.functions.map(f => f.codebase)).toEqual(['team'])
    // No other export shares the prefix the CLI filter matches on (id === name || id.startsWith(name + '-')).
    const names = [...index.matchAll(/^export const (\w+)\s+=\s+(wrap|onCall|onSchedule|clientFinanceCall)\(/gm)].map(m => m[1])
    expect(names).toHaveLength(17)   // + transferBoqToBudget (ADR-81) + the six client-finance callables (ADR-89)
    expect(names.filter(n => n === 'approveFinalAccount' || n.startsWith('approveFinalAccount-'))).toEqual(['approveFinalAccount'])
  })

  it('reads are bounded, an over-limit register is refused by name, and only ABORTED becomes a typed "busy"', () => {
    const approve = src('finalAccount/approve.js')
    expect(approve).toContain('export const SOURCE_DOCUMENT_LIMIT = 5000')
    expect((approve.match(/\.limit\(limit \+ 1\)/g) || []).length).toBe(4)
    expect(approve).toContain('fail(CODE.FINAL_ACCOUNT_TOO_LARGE, { registers: over, limit })')
    expect(approve).toContain('if (!err?.details?.code && err?.code === GRPC_ABORTED)')
    expect(approve).toContain('fail(CODE.FINAL_ACCOUNT_BUSY')
    // The function may run for 120 s — under the 270 s transaction limit.
    expect(src('index.js')).toMatch(/FINAL_ACCOUNT_CALL_OPTIONS = \{[^}]*timeoutSeconds: 120,/)
  })
})
