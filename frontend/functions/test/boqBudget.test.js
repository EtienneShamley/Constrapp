import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createBoqBudgetHandlers, parseTransferBoqToBudget, BOQ_BUDGET_HANDLER_NAMES } from '../src/boqBudget/handlers.js'
import { TRANSFER_MAX_ATTEMPTS } from '../src/boqBudget/transfer.js'
import { assertActiveRole } from '../src/lib/authz.js'
import { CODE, isTeamError } from '../src/lib/errors.js'
import { AUDIT } from '../src/lib/audit.js'
import * as calc from '../src/generated/boqBudgetTransferCalc.js'

// ── transferBoqToBudget — pins that need no Firestore (ADR-81) ───────────────
//
// The emulator-backed behaviour (transactions, races, idempotence) lives in
// frontend/tests/functions/boqBudgetTransfer.test.js; the freshness and
// client/server equality of the generated proposal in
// frontend/tests/unit/boqBudgetTransferBundle.test.js. This file runs in the
// Functions PREDEPLOY chain, so a deploy cannot ship a broken gate or a
// generated file that is missing or not self-contained.

const src = (rel) => readFileSync(fileURLToPath(new URL(`../src/${rel}`, import.meta.url)), 'utf8')
const deps = (over = {}) => ({ db: null, now: () => new Date('2026-11-21T00:00:00Z'), log: { info() {}, warn() {}, error() {} }, config: () => ({ enabled: true }), ...over })
const refused = async (promise, code) => {
  try { await promise } catch (e) { expect(isTeamError(e, code), `${e?.details?.code ?? e?.message}`).toBe(true); return }
  throw new Error('no throw')
}
const KEY = 'v1:' + '0123456789abcdef'.repeat(2)

describe('handler gates before any data access', () => {
  it('exactly one handler', () => {
    expect(BOQ_BUDGET_HANDLER_NAMES).toEqual(['transferBoqToBudget'])
    expect(typeof createBoqBudgetHandlers(deps()).transferBoqToBudget).toBe('function')
  })
  it('the kill switch answers first; then authentication; then validation — db is never touched (it is null)', async () => {
    const off = createBoqBudgetHandlers(deps({ config: () => ({ enabled: false }) }))
    await refused(off.transferBoqToBudget({ auth: { uid: 'u' }, data: {} }), CODE.BOQ_TRANSFER_DISABLED)
    const h = createBoqBudgetHandlers(deps())
    await refused(h.transferBoqToBudget({ auth: null, data: { nonsense: true } }), CODE.UNAUTHENTICATED)
    await refused(h.transferBoqToBudget({ auth: { uid: 'u' }, data: { projectId: 'p', reviewKey: KEY, setToZero: [], amount: 5 } }), CODE.INVALID_ARGUMENT)
  })
})

describe('request schema — identifiers and guards only', () => {
  const ok = { projectId: 'projectA', reviewKey: KEY, setToZero: ['cc2', 'cc1'] }
  it('accepts the exact shape and returns the choices sorted', () => {
    expect(parseTransferBoqToBudget(ok)).toEqual({ projectId: 'projectA', reviewKey: KEY, setToZero: ['cc1', 'cc2'] })
    expect(parseTransferBoqToBudget({ ...ok, setToZero: [] }).setToZero).toEqual([])
  })
  it.each([
    ['an amount', { ...ok, budgeted: 100 }],
    ['a lines array', { ...ok, lines: [] }],
    ['a companyId', { ...ok, companyId: 'c' }],
    ['a missing reviewKey', { projectId: 'p', setToZero: [] }],
    ['a missing setToZero', { projectId: 'p', reviewKey: KEY }],
    ['a malformed reviewKey', { ...ok, reviewKey: 'v1:xyz' }],
    ['an upper-case reviewKey', { ...ok, reviewKey: KEY.toUpperCase() }],
    ['setToZero as a string', { ...ok, setToZero: 'cc1' }],
    ['a duplicate set-to-zero id', { ...ok, setToZero: ['cc1', 'cc1'] }],
    ['a path in a set-to-zero id', { ...ok, setToZero: ['a/b'] }],
    ['a non-string set-to-zero id', { ...ok, setToZero: [1] }],
    ['a path in projectId', { ...ok, projectId: 'a/b' }],
    ['an empty projectId', { ...ok, projectId: '' }],
    ['null', null], ['a string', 'x'], ['an array', [ok]],
  ])('refuses %s', (_label, data) => {
    try { parseTransferBoqToBudget(data); throw new Error('no throw') } catch (e) { expect(isTeamError(e, CODE.INVALID_ARGUMENT)).toBe(true) }
  })
})

describe('membership', () => {
  const check = (profile) => { try { assertActiveRole(profile, calc.BOQ_TRANSFER_ROLES, CODE.BOQ_TRANSFER_FORBIDDEN); return 'ok' } catch (e) { return e.details.code } }
  it('only an ACTIVE company_admin, project_manager or qs of a company passes', () => {
    expect(calc.BOQ_TRANSFER_ROLES).toEqual(['company_admin', 'project_manager', 'qs'])
    for (const role of calc.BOQ_TRANSFER_ROLES) expect(check({ role, companyId: 'c', status: 'active' })).toBe('ok')
    expect(check({ role: 'qs', companyId: 'c' })).toBe('ok')                               // legacy profile, no status
    for (const role of ['subcontractor', 'client', 'super_admin', undefined]) expect(check({ role, companyId: 'c' })).toBe(CODE.BOQ_TRANSFER_FORBIDDEN)
    expect(check(null)).toBe(CODE.NO_MEMBERSHIP)
    expect(check({ role: 'qs', companyId: null })).toBe(CODE.NO_MEMBERSHIP)
    expect(check({ role: 'company_admin', companyId: 'c', status: 'deactivated' })).toBe(CODE.MEMBERSHIP_INACTIVE)
  })
})

describe('the generated proposal shipped with the function', () => {
  const bundle = src('generated/boqBudgetTransferCalc.js')
  it('is present, marked generated, and imports nothing', () => {
    expect(bundle.startsWith('// GENERATED FILE — DO NOT EDIT.')).toBe(true)
    const code = bundle.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
    expect(code).not.toMatch(/^\s*import\s/m)
    expect(code).not.toMatch(/\brequire\(|\bimport\(|import\.meta|\bwindow\.|\bdocument\./)
  })
  it('exports the functions the operation calls', () => {
    for (const name of ['buildTransferProposal', 'transferOperations', 'transferSummary', 'transferRequestKey', 'resultKeyAfter', 'findAppliedRequest', 'resolveProjectCurrency', 'centsToAmount', 'isReviewKeyShape', 'normaliseZeroChoices']) {
      expect(typeof calc[name], name).toBe('function')
    }
    expect(calc.TRANSFER_OUTCOME).toEqual({ APPLIED: 'applied', ALREADY_APPLIED: 'already-applied', UNCHANGED: 'unchanged' })
  })
  it('an empty project proposes nothing — no row, no operation', () => {
    const p = calc.buildTransferProposal({ boqItems: [], budgetLines: [], costCodes: [], currencyCode: 'AUD' })
    expect(p.rows).toEqual([])
    expect(calc.transferOperations(p, []).operations).toEqual([])
  })
})

describe('surface', () => {
  const index = src('index.js')
  const transfer = src('boqBudget/transfer.js')
  it('one more callable, App Check enforced, no secret, its own kill switch; the others untouched', () => {
    expect(index).toContain('export const transferBoqToBudget = onCall(BOQ_TRANSFER_CALL_OPTIONS')
    const opts = index.slice(index.indexOf('export const BOQ_TRANSFER_CALL_OPTIONS'), index.indexOf('let boqBudgetHandlers'))
    expect(opts).toMatch(/enforceAppCheck:\s*true/)
    expect(opts).toMatch(/region:\s*REGION/)
    expect(opts).not.toMatch(/secrets|serviceAccount/)
    expect(index).toContain('BOQ_BUDGET_TRANSFER_ENABLED.value()')
    expect(index).toContain('export const approveFinalAccount = onCall(FINAL_ACCOUNT_CALL_OPTIONS')
    expect((index.match(/wrap\('/g) || []).length).toBe(8)
    expect((index.match(/onSchedule\(/g) || []).length).toBe(1)
  })
  it('the operation is one transaction with a bounded retry, writes one audit type, and stamps server time', () => {
    expect((transfer.match(/db\.runTransaction\(/g) || []).length).toBe(1)
    expect(transfer).toContain('{ maxAttempts: TRANSFER_MAX_ATTEMPTS }')
    expect(TRANSFER_MAX_ATTEMPTS).toBe(5)
    expect(AUDIT.BOQ_BUDGET_TRANSFERRED).toBe('boq_budget.transferred')
    expect(transfer).toContain('createdAt: FieldValue.serverTimestamp()')
    expect(transfer).toContain("'boqSource.latest': latest")
    expect(transfer).toContain('{ lastUpdateTime: sources.updateTimes.get(op.lineId) }')
    expect(transfer).toContain('if (!err?.details?.code && err?.code === GRPC_ABORTED)')
    // The function may run for 120 s — under the 270 s transaction limit.
    expect(index).toMatch(/BOQ_TRANSFER_CALL_OPTIONS = \{[^}]*timeoutSeconds: 120,/)
  })
  it('reads are bounded by detection, and an over-limit register is refused by name', () => {
    expect((transfer.match(/\.limit\(limit \+ 1\)/g) || []).length).toBe(3)
    expect(transfer).toContain('fail(CODE.BOQ_TRANSFER_TOO_LARGE, { registers: over, limit })')
  })
})

describe('release safety', () => {
  const DIR = fileURLToPath(new URL('../', import.meta.url))
  const envFiles = readdirSync(DIR).filter(f => /^\.env\.[a-z0-9-]+$/.test(f) && f !== '.env.local')
  const valueOf = (file, key) => readFileSync(join(DIR, file), 'utf8').split('\n').find(l => l.startsWith(`${key}=`))?.slice(key.length + 1)

  it('the feature flag DEFAULTS TO OFF in code (fail closed) and every project env file states it explicitly', () => {
    expect(src('lib/params.js')).toContain("export const BOQ_BUDGET_TRANSFER_ENABLED = defineBoolean('BOQ_BUDGET_TRANSFER_ENABLED', { default: false })")
    for (const f of envFiles) expect(['true', 'false'], f).toContain(valueOf(f, 'BOQ_BUDGET_TRANSFER_ENABLED'))
    // Architect decision, 21 November 2026: enabled for the controlled production release.
    expect(valueOf('.env.constrapp-69b5d', 'BOQ_BUDGET_TRANSFER_ENABLED')).toBe('true')
  })
  it('the flag is read by the new callable ONLY — no other function, handler or library module names it', () => {
    const index = src('index.js')
    expect((index.match(/BOQ_BUDGET_TRANSFER_ENABLED/g) || []).length).toBe(2)   // the import and the one config()
    const block = index.slice(index.indexOf('export const transferBoqToBudget = onCall('), index.indexOf('// ── Scheduled worker'))
    expect(block).toContain('config: () => ({ enabled: BOQ_BUDGET_TRANSFER_ENABLED.value() })')
    const fa = index.slice(index.indexOf('export const approveFinalAccount = onCall('), index.indexOf('export const BOQ_TRANSFER_CALL_OPTIONS'))
    expect(fa).toContain('config: () => ({ enabled: FINAL_ACCOUNT_APPROVAL_ENABLED.value() })')
    expect(fa).not.toContain('BOQ_BUDGET_TRANSFER_ENABLED')
    for (const f of ['finalAccount/handlers.js', 'finalAccount/approve.js', 'team/handlers.js']) expect(src(f), f).not.toContain('BOQ_BUDGET_TRANSFER')
    expect(src('finalAccount/handlers.js')).toContain('fail(CODE.FINAL_ACCOUNT_DISABLED)')
  })
  it('the local emulator override is ignored by Git and by the Functions deploy; no env file carries a secret', () => {
    expect(readFileSync(join(DIR, '.gitignore'), 'utf8').split('\n')).toContain('.env.local')
    const firebaseJson = JSON.parse(readFileSync(join(DIR, '../firebase.json'), 'utf8'))
    expect(firebaseJson.functions[0].ignore).toContain('*.local')
    for (const f of envFiles) {
      const body = readFileSync(join(DIR, f), 'utf8')
      expect(body, f).not.toMatch(/EMAIL_API_KEY\s*=|PRIVATE KEY|re_[A-Za-z0-9]{16,}|AIza[0-9A-Za-z_-]{20,}/)
    }
  })
  it('adding the flag changed no existing production parameter', () => {
    expect(valueOf('.env.constrapp-69b5d', 'TEAM_MANAGEMENT_ENABLED')).toBe('true')
    expect(valueOf('.env.constrapp-69b5d', 'FILE_LINK_REVOCATION_ENABLED')).toBe('true')
    expect(valueOf('.env.constrapp-69b5d', 'FILE_LINK_RECONCILE_INTERVAL_HOURS')).toBe('2')
    expect(valueOf('.env.constrapp-69b5d', 'FINAL_ACCOUNT_APPROVAL_ENABLED')).toBe('true')
    expect(valueOf('.env.constrapp-69b5d', 'STORAGE_BUCKET')).toBe('')
  })
  it('the function is exported under the exact name the deploy filter names, and no other export shares its prefix', () => {
    const index = src('index.js')
    expect(index.match(/^export const transferBoqToBudget = onCall\(/m)).not.toBeNull()
    const names = [...index.matchAll(/^export const (\w+)\s+=\s+(wrap|onCall|onSchedule)\(/gm)].map(m => m[1])
    expect(names).toHaveLength(11)
    expect(names.filter(n => n === 'transferBoqToBudget' || n.startsWith('transferBoqToBudget-'))).toEqual(['transferBoqToBudget'])
  })
})
