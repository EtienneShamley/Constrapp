import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createVariationHandlers, VARIATION_HANDLER_NAMES } from '../src/variations/handlers.js'
import { VARIATION_ROLES, parseCreateVariation, parseUpdateVariationDraft, parseApproveVariation, parseApplyVariationCommitment } from '../src/variations/contracts.js'
import { VARIATION_MAX_ATTEMPTS, COUNTER_MAX } from '../src/variations/operations.js'
import { assertActiveRole } from '../src/lib/authz.js'
import { CODE, TeamError, isTeamError } from '../src/lib/errors.js'
import { AUDIT, auditPayload } from '../src/lib/audit.js'
import * as calc from '../src/generated/variationCalc.js'

// ── The variation callables — pins that need no Firestore (ADR-90) ───────────
//
// The emulator-backed behaviour (transactions, races, idempotence, roles) lives
// in frontend/tests/functions/variations.test.js; the freshness and
// client/server equality of the generated domain in
// frontend/tests/unit/variationBundle.test.js. This file runs in the Functions
// PREDEPLOY chain, so a deploy cannot ship a broken gate, a loosened contract
// or a generated file that is missing or not self-contained.

const src = (rel) => readFileSync(fileURLToPath(new URL(`../src/${rel}`, import.meta.url)), 'utf8')
const code = (rel) => src(rel).split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
const deps = (over = {}) => ({ db: null, now: () => new Date('2026-11-27T00:00:00Z'), log: { info() {}, warn() {}, error() {} }, config: () => ({ enabled: true }), ...over })
const refused = async (promise, expected) => {
  try { await promise } catch (e) { expect(isTeamError(e, expected), `${e?.details?.code ?? e?.message}`).toBe(true); return e }
  throw new Error('no throw')
}
const throws = (fn, expected) => {
  try { fn() } catch (e) { expect(isTeamError(e, expected), `${e?.details?.code ?? e?.message}`).toBe(true); return e }
  throw new Error('no throw')
}

const createRequest = (o = {}) => ({
  projectId: 'p1', variationId: 'v1', variationType: 'supplier',
  title: 'Additional steel', description: '', reason: '',
  clientId: null, clientName: null, clientRef: null,
  supplierId: 's1', supplierName: 'Steel Co', supplierRef: '', poId: null,
  originRfiId: null, identifiedDate: '', submittedDate: '', responseDueDate: '', effectiveDate: '', notes: '',
  lines: [{ poLineIndex: null, costCodeId: 'cc1', description: '', submittedAmount: 100, taxCode: 'gst' }],
  ...o,
})
const approveRequest = (o = {}) => ({ projectId: 'p1', variationId: 'v1', expectedRevision: 2, approvedAmounts: [100], assessmentNotes: '', approvedDate: '2026-11-27', ...o })
const updateRequest = (o = {}) => ({
  projectId: 'p1', variationId: 'v1', expectedRevision: 1,
  title: 'Additional steel', description: '', reason: '', clientRef: null, supplierRef: '',
  identifiedDate: '', responseDueDate: '', effectiveDate: '', notes: null, changeOriginRfi: false, originRfiId: null,
  lines: [{ poLineIndex: null, costCodeId: 'cc1', description: '', submittedAmount: 100, taxCode: 'gst' }],
  ...o,
})
const applyRequest = (o = {}) => ({ projectId: 'p1', variationId: 'v1', expectedRevision: 3, ...o })

describe('handler gates before any data access', () => {
  it('exactly four handlers', () => {
    expect(VARIATION_HANDLER_NAMES).toEqual(['createVariation', 'updateVariationDraft', 'approveVariation', 'applyVariationCommitment'])
    const h = createVariationHandlers(deps())
    for (const n of VARIATION_HANDLER_NAMES) expect(typeof h[n]).toBe('function')
  })

  it('the switch answers first; then authentication; then validation — db is never touched (it is null)', async () => {
    for (const n of VARIATION_HANDLER_NAMES) {
      // Fail closed: anything but an explicit `true` is OFF.
      for (const enabled of [false, undefined, null, 'true', 1]) {
        const off = createVariationHandlers(deps({ config: () => ({ enabled }) }))
        await refused(off[n]({ auth: { uid: 'u' }, data: {} }), CODE.VARIATION_DISABLED)
      }
      const h = createVariationHandlers(deps())
      await refused(h[n]({ auth: null, data: { nonsense: true } }), CODE.UNAUTHENTICATED)
      await refused(h[n]({ auth: { uid: '' }, data: {} }), CODE.UNAUTHENTICATED)
      await refused(h[n]({ auth: { uid: 'u' }, data: { projectId: 'p1' } }), CODE.INVALID_ARGUMENT)
    }
  })
})

describe('request contracts — authored content and identifiers only', () => {
  it('create: the domain module’s exact key set; any derived figure, a number, a currency, a stamp or a companyId refuses the request', () => {
    expect(parseCreateVariation(createRequest())).toEqual(createRequest())
    for (const extra of ['submittedGst', 'submittedSubtotal', 'submittedTotal', 'variationNumber', 'currency', 'status', 'calcVersion', 'companyId', 'createdBy', 'poNumber', 'revision', 'commitmentAppliedAt']) {
      const e = throws(() => parseCreateVariation({ ...createRequest(), [extra]: 1 }), CODE.INVALID_ARGUMENT)
      expect(e.details.field).toBe('keys')
    }
    throws(() => parseCreateVariation({ ...createRequest(), lines: [{ ...createRequest().lines[0], submittedGst: 10 }] }), CODE.INVALID_ARGUMENT)
    throws(() => parseCreateVariation({ ...createRequest(), lines: [{ ...createRequest().lines[0], costCodeName: 'x' }] }), CODE.INVALID_ARGUMENT)
    for (const bad of [null, undefined, 'x', 5, [], [createRequest()]]) throws(() => parseCreateVariation(bad), CODE.INVALID_ARGUMENT)
    throws(() => parseCreateVariation(createRequest({ projectId: 'a/b' })), CODE.INVALID_ARGUMENT)
    throws(() => parseCreateVariation(createRequest({ title: '' })), CODE.INVALID_ARGUMENT)
    throws(() => parseCreateVariation(createRequest({ lines: [] })), CODE.INVALID_ARGUMENT)
    throws(() => parseCreateVariation(createRequest({ lines: [{ ...createRequest().lines[0], submittedAmount: '100' }] })), CODE.INVALID_ARGUMENT)
    // The parsed request is a copy: changing it cannot change the caller's object.
    const original = createRequest()
    parseCreateVariation(original).lines[0].submittedAmount = 5
    expect(original.lines[0].submittedAmount).toBe(100)
  })

  it('edit a draft: the reviewed revision, authored content, an explicit RFI change — any derived figure, identity field or stamp refuses the request', () => {
    expect(parseUpdateVariationDraft(updateRequest())).toEqual(updateRequest())
    for (const extra of ['submittedGst', 'submittedSubtotal', 'submittedTotal', 'status', 'calcVersion', 'variationNumber', 'variationType', 'poId', 'supplierId', 'supplierName', 'currency', 'revision', 'updatedBy', 'companyId', 'approvedAmounts', 'commitmentAppliedAt']) {
      const e = throws(() => parseUpdateVariationDraft({ ...updateRequest(), [extra]: 1 }), CODE.INVALID_ARGUMENT)
      expect(e.details.field).toBe('keys')
    }
    for (const k of Object.keys(updateRequest())) {
      const missing = updateRequest(); delete missing[k]
      throws(() => parseUpdateVariationDraft(missing), CODE.INVALID_ARGUMENT)
    }
    throws(() => parseUpdateVariationDraft(updateRequest({ lines: [{ ...updateRequest().lines[0], submittedGst: 10 }] })), CODE.INVALID_ARGUMENT)
    throws(() => parseUpdateVariationDraft(updateRequest({ lines: [{ ...updateRequest().lines[0], approvedAmount: 10 }] })), CODE.INVALID_ARGUMENT)
    throws(() => parseUpdateVariationDraft(updateRequest({ expectedRevision: '1' })), CODE.INVALID_ARGUMENT)
    throws(() => parseUpdateVariationDraft(updateRequest({ clientRef: 'both', supplierRef: 'sides' })), CODE.INVALID_ARGUMENT)
    throws(() => parseUpdateVariationDraft(updateRequest({ originRfiId: 'rfi1' })), CODE.INVALID_ARGUMENT)   // an id without the change flag
    expect(parseUpdateVariationDraft(updateRequest({ changeOriginRfi: true, originRfiId: 'rfi1' })).originRfiId).toBe('rfi1')
    const original = updateRequest()
    parseUpdateVariationDraft(original).lines[0].submittedAmount = 5
    expect(original.lines[0].submittedAmount).toBe(100)
  })

  it('approve: ids, the reviewed revision, one finite amount per line, notes ≤ 5000, a calendar day — nothing else', () => {
    expect(parseApproveVariation(approveRequest({ assessmentNotes: '  agreed  ' }))).toEqual(approveRequest({ assessmentNotes: 'agreed' }))
    for (const extra of ['approvedGst', 'approvedSubtotal', 'approvedTotal', 'approvedBy', 'status', 'commitmentAppliedAt', 'lineItems', 'companyId', 'calcVersion', 'applyCommitment']) {
      throws(() => parseApproveVariation({ ...approveRequest(), [extra]: 1 }), CODE.INVALID_ARGUMENT)
    }
    for (const k of Object.keys(approveRequest())) {
      const missing = approveRequest(); delete missing[k]
      throws(() => parseApproveVariation(missing), CODE.INVALID_ARGUMENT)
    }
    for (const rev of [-1, 1.5, '2', null, Number.MAX_SAFE_INTEGER + 2]) throws(() => parseApproveVariation(approveRequest({ expectedRevision: rev })), CODE.INVALID_ARGUMENT)
    expect(parseApproveVariation(approveRequest({ expectedRevision: 0 })).expectedRevision).toBe(0)   // a legacy document with no revision key
    for (const amounts of [[], ['100'], [NaN], [Infinity], [1e15], 'x', Array(201).fill(1)]) throws(() => parseApproveVariation(approveRequest({ approvedAmounts: amounts })), CODE.INVALID_ARGUMENT)
    expect(parseApproveVariation(approveRequest({ approvedAmounts: [-250.5, 0] })).approvedAmounts).toEqual([-250.5, 0])
    throws(() => parseApproveVariation(approveRequest({ assessmentNotes: 'x'.repeat(5001) })), CODE.INVALID_ARGUMENT)
    throws(() => parseApproveVariation(approveRequest({ assessmentNotes: null })), CODE.INVALID_ARGUMENT)
    for (const d of ['', '27/11/2026', '2026-11-27T00:00:00Z', null, 20261127]) throws(() => parseApproveVariation(approveRequest({ approvedDate: d })), CODE.INVALID_ARGUMENT)
  })

  it('apply: the project, the variation and the reviewed revision — nothing else', () => {
    expect(parseApplyVariationCommitment(applyRequest())).toEqual(applyRequest())
    for (const extra of ['commitmentAppliedAt', 'commitmentAppliedBy', 'scopeCommittedAt', 'poId', 'companyId', 'reason']) {
      throws(() => parseApplyVariationCommitment({ ...applyRequest(), [extra]: 'x' }), CODE.INVALID_ARGUMENT)
    }
    throws(() => parseApplyVariationCommitment({ projectId: 'p1', variationId: 'v1' }), CODE.INVALID_ARGUMENT)
    throws(() => parseApplyVariationCommitment(applyRequest({ variationId: '' })), CODE.INVALID_ARGUMENT)
    throws(() => parseApplyVariationCommitment(applyRequest({ expectedRevision: '3' })), CODE.INVALID_ARGUMENT)
  })
})

describe('who may create, approve and apply', () => {
  it('the roles Security Rules let draft a variation — and only while ACTIVE members of a company', () => {
    expect(VARIATION_ROLES).toEqual(['company_admin', 'project_manager', 'qs'])
    const ok = (role) => assertActiveRole({ role, companyId: 'c1', status: 'active' }, VARIATION_ROLES, CODE.VARIATION_FORBIDDEN)
    for (const role of VARIATION_ROLES) expect(ok(role).companyId).toBe('c1')
    for (const role of ['subcontractor', 'client', 'super_admin', 'viewer', '', null]) throws(() => ok(role), CODE.VARIATION_FORBIDDEN)
    throws(() => assertActiveRole(null, VARIATION_ROLES, CODE.VARIATION_FORBIDDEN), CODE.NO_MEMBERSHIP)
    throws(() => assertActiveRole({ role: 'company_admin', companyId: null, status: 'deactivated' }, VARIATION_ROLES, CODE.VARIATION_FORBIDDEN), CODE.MEMBERSHIP_INACTIVE)
    throws(() => assertActiveRole({ role: 'qs', companyId: null }, VARIATION_ROLES, CODE.VARIATION_FORBIDDEN), CODE.NO_MEMBERSHIP)
  })
})

describe('the generated domain shipped with the functions', () => {
  const bundle = src('generated/variationCalc.js')
  it('is present, marked generated, and imports nothing', () => {
    expect(bundle.startsWith('// GENERATED FILE — DO NOT EDIT.')).toBe(true)
    const body = bundle.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
    expect(body).not.toMatch(/^\s*import\s/m)
    expect(body).not.toMatch(/\brequire\(|\bimport\(/)
  })
  it('exports what the operations call, and stamps calculation version 2', () => {
    for (const name of [
      'VARIATION_PROCESSING_ROLES', 'VARIATION_COUNTER_ID', 'VARIATION_STATUS', 'CALC_VERSION', 'CURRENT_CALC_VERSION', 'CREATE_PROBLEM',
      'APPROVABLE_STATUSES', 'ASSESSMENT_NOTES_MAX', 'COMMITMENT_APPLY_BLOCKER', 'VariationWriteError',
      'createVariationRequestProblem', 'requestedCostCodeIds', 'buildVariationDraft', 'resolveProjectCurrency',
      'DRAFT_PROBLEM', 'updateVariationRequestProblem', 'buildVariationDraftUpdate', 'draftAlreadyHolds',
      'approvedSideProblem', 'storedCostCodeIds', 'lineSources', 'withAuthoritativeNames',
      'variationCalcVersion', 'sameApproval', 'storedRevision', 'submittedSideProblem', 'isPoLinkedSupplierVariation', 'shouldApplyOnApproval',
      'transitionUpdate', 'approvedHeaderSupported', 'approvalActorEvidence', 'approvedAmountsProblem',
      'isCommitmentApplied', 'isScopeCommitted', 'commitmentApplyEligibility', 'applyCommitmentUpdate',
    ]) expect(calc[name], name).toBeDefined()
    expect(calc.CURRENT_CALC_VERSION).toBe(2)
    expect(calc.CALC_VERSION).toEqual({ LEGACY: 1, EXACT: 2 })
    expect(calc.VARIATION_COUNTER_ID).toEqual({ client: 'variationsClient', supplier: 'variationsSupplier' })
  })
})

describe('surface', () => {
  const index = src('index.js')
  const FILES = ['contracts.js', 'handlers.js', 'operations.js']

  it('four more callables: App Check enforced, the one region, no secret, no service account, one switch', () => {
    for (const n of VARIATION_HANDLER_NAMES) expect(index).toMatch(new RegExp(`^export const ${n}\\s+= variationOperation\\('${n}'\\)$`, 'm'))
    const opts = index.slice(index.indexOf('export const VARIATION_CALL_OPTIONS'), index.indexOf('let variationHandlers'))
    expect(opts).toMatch(/enforceAppCheck:\s*true/)
    expect(opts).toMatch(/region:\s*REGION/)
    expect(opts).toMatch(/maxInstances:\s*5/)
    expect(opts).toMatch(/timeoutSeconds:\s*60/)
    expect(opts).not.toMatch(/secrets|serviceAccount/)
    expect(index).toContain('const variationOperation = (name) => onCall(VARIATION_CALL_OPTIONS,')
    expect((index.match(/VARIATION_PROCESSING_ENABLED/g) || []).length).toBe(2)   // the import and the one config()
    expect(index).toContain('config: () => ({ enabled: VARIATION_PROCESSING_ENABLED.value() })')
    // The existing surface is untouched.
    expect((index.match(/wrap\('/g) || []).length).toBe(8)
    expect((index.match(/clientFinanceCall\('/g) || []).length).toBe(11)   // 6 (ADR-89) + 5 (Phase 2 step 5: refunds, applications, invoice void)
    expect((index.match(/onSchedule\(/g) || []).length).toBe(1)
    expect(index).not.toMatch(/onRequest\(/)
    // No export shares a prefix the CLI deploy filter matches on.
    const names = [...index.matchAll(/^export const (\w+)\s+=\s+(wrap|onCall|onSchedule|clientFinanceCall|variationOperation)\(/gm)].map(m => m[1])
    for (const n of VARIATION_HANDLER_NAMES) expect(names.filter(x => x === n || x.startsWith(`${n}-`))).toEqual([n])
    expect(new Set(names).size).toBe(names.length)
  })

  it('no formula of its own: every figure and every decision comes from the generated bundle', () => {
    for (const f of FILES) {
      const c = code(`variations/${f}`)
      expect(c, f).not.toMatch(/\b0\.1\b|GST_RATE|roundMoney|toFixed/)
      expect(c, f).not.toMatch(/from '\.\.\/\.\.\/\.\.\/src|from 'firebase\//)
    }
    expect(code('variations/operations.js')).toContain("import * as calc from '../generated/variationCalc.js'")
    expect(code('variations/contracts.js')).toContain('calc.createVariationRequestProblem(data)')
  })

  it('the company comes from the membership, read INSIDE the transaction, and every read is transactional', () => {
    const ops = code('variations/operations.js')
    expect(ops).toContain('const profileSnap = await tx.get(userRef(db, uid))')
    expect(ops).toContain('assertActiveRole(profileSnap.exists ? profileSnap.data() : null, VARIATION_ROLES, CODE.VARIATION_FORBIDDEN)')
    expect(ops).toContain("const companyRef = db.collection('companies').doc(profile.companyId)")
    expect(ops).not.toMatch(/input\.companyId|data\.companyId/)
    // No read outside a transaction, no query, no register.
    expect(ops).not.toMatch(/\.where\(|\.limit\(|\.orderBy\(|collectionGroup\(/)
    expect(ops).not.toMatch(/(?<!tx)\.get\(\)/)
    expect((ops.match(/await callerScope\(tx, db, uid, input\.projectId\)/g) || []).length).toBe(4)
    expect(VARIATION_MAX_ATTEMPTS).toBe(5)
  })

  it('writes are the variation (+ the counter and the currency lock on create) and — for the three operations that create a financial fact — ONE audit event; each stamped with server time, each guarded', () => {
    const ops = code('variations/operations.js')
    expect((ops.match(/tx\.create\(/g) || []).length).toBe(1)                      // the variation; an audit event is created inside auditInTx
    expect((ops.match(/tx\.set\(/g) || []).length).toBe(1)                         // the counter
    expect((ops.match(/tx\.update\(/g) || []).length).toBe(4)                      // currency lock, draft edit, approve, apply
    expect((ops.match(/lastUpdateTime:/g) || []).length).toBe(4)
    expect((ops.match(/auditInTx\(/g) || []).length).toBe(3)                       // create, approve, apply — a draft edit creates no financial fact
    expect((ops.match(/FieldValue\.serverTimestamp\(\)/g) || []).length).toBe(4)
    expect(ops).toContain('tx.set(counterRef, { next: next + 1 }, { merge: true })')
    // ADR-96: the stored draft also records its editor provenance (createdEditorStamp) for approval segregation.
    expect(ops).toContain('tx.create(variationRef, { ...built.document, ...createdEditorStamp(uid) })')
    for (const never of ["'budgetLines'", "'progressClaims'", "'supplierInvoices'", "'approvedBudget'", "'budgetApprovals'"]) expect(ops, never).not.toContain(never)
    // The purchase order, the RFI and the cost codes are READ, never written.
    expect(ops).not.toMatch(/tx\.(update|set|create)\((poRef|rfiRef)/)
    expect((ops.match(/tx\.(update|set|create)\(/g) || []).length).toBe(6)
    expect(ops).not.toMatch(/tx\.delete\(|\.delete\(\)/)
  })

  it('NOTHING STORED IS TRUSTED when it is about to become authoritative: approval verifies the submitted side and every cost-code relationship; apply verifies the approved side and the same relationships — before any write', () => {
    const ops = code('variations/operations.js')
    const approve = ops.slice(ops.indexOf('export async function approveVariation'), ops.indexOf('export async function applyVariationCommitment'))
    const apply = ops.slice(ops.indexOf('export async function applyVariationCommitment'))
    for (const [name, body, verify] of [['approve', approve, 'calc.submittedSideProblem(live)'], ['apply', apply, 'calc.approvedSideProblem(live)']]) {
      expect(body, name).toContain(verify)
      expect(body, name).toContain('calc.lineSources(live, { po, costCodes })')
      expect(body, name).toContain('await readCostCodes(tx, companyRef, calc.storedCostCodeIds(live))')
      expect(body.indexOf(verify), name).toBeLessThan(body.indexOf('tx.update('))
      expect(body.indexOf('calc.lineSources('), name).toBeLessThan(body.indexOf('tx.update('))
    }
    // The verification applies to EVERY calculation version — it is not gated on version 2.
    expect(approve).not.toMatch(/if \(version === calc\.CALC_VERSION\.EXACT\)/)
    // The certified lines take their cost-code names from the verified sources.
    expect(approve).toContain('update.lineItems = calc.withAuthoritativeNames(update.lineItems, sources.names)')
    // A draft edit and a create derive every stored line from the request — nothing a client stored is copied.
    const update = ops.slice(ops.indexOf('export async function updateVariationDraft'), ops.indexOf('export async function approveVariation'))
    expect(update).toContain('calc.buildVariationDraftUpdate({ input, live, po, costCodes, rfi, uid, now: FieldValue.serverTimestamp() })')
    expect(update).toContain("if (live.status !== calc.VARIATION_STATUS.DRAFT) fail(CODE.VARIATION_NOT_DRAFT")
    expect(update).toContain('if (calc.storedRevision(live) !== input.expectedRevision) fail(CODE.VARIATION_STALE')
  })

  it('the number counter is used only when it is a positive whole number within bounds', () => {
    const ops = code('variations/operations.js')
    expect(COUNTER_MAX).toBe(999_999_999)
    expect(ops).toContain("if (!Number.isSafeInteger(next) || next < 1 || next > COUNTER_MAX) fail(CODE.VARIATION_UNSUPPORTED_RECORD, { reason: 'counter' })")
  })

  it('three audit types, each accepted by the audit writer', () => {
    expect(AUDIT.VARIATION_CREATED).toBe('variation.created')
    expect(AUDIT.VARIATION_APPROVED).toBe('variation.approved')
    expect(AUDIT.VARIATION_COMMITMENT_APPLIED).toBe('variation.commitment_applied')
    for (const type of [AUDIT.VARIATION_CREATED, AUDIT.VARIATION_APPROVED, AUDIT.VARIATION_COMMITMENT_APPLIED]) {
      expect(auditPayload({ type, actorUid: 'u' }, new Date()).type).toBe(type)
    }
  })

  it('the refusals: stable codes; a specific message never changes the code; an uncertain outcome is never typed', () => {
    const codes = Object.entries(CODE).filter(([k]) => k.startsWith('VARIATION_'))
    expect(codes).toHaveLength(15)
    for (const [, value] of codes) {
      expect(value).toMatch(/^variation-/)
      const e = new TeamError(value)
      expect(e.details.code).toBe(value)
      expect(e.message.length).toBeGreaterThan(10)
    }
    const specific = new TeamError(CODE.VARIATION_PO_INVALID, { message: 'PO-0001 is not sent or closed.', poStatus: 'cancelled' })
    expect(specific.message).toBe('PO-0001 is not sent or closed.')
    expect(specific.details).toEqual({ code: 'variation-po-invalid', poStatus: 'cancelled' })
    expect(new TeamError(CODE.VARIATION_PO_INVALID, { message: '' }).message).toMatch(/purchase order/)
    expect(new TeamError(CODE.VARIATION_DISABLED).code).toBe('unavailable')
    expect(new TeamError(CODE.VARIATION_STALE).code).toBe('aborted')
    expect(new TeamError(CODE.VARIATION_BUSY).code).toBe('aborted')
    expect(new TeamError(CODE.VARIATION_FORBIDDEN).code).toBe('permission-denied')
    expect(new TeamError(CODE.VARIATION_ID_CONFLICT).code).toBe('already-exists')
    // Only gRPC ABORTED (contention: nothing committed) is turned into a typed refusal.
    const ops = code('variations/operations.js')
    expect(ops).toContain('if (!err?.details?.code && err?.code === GRPC_ABORTED)')
    expect((ops.match(/fail\(CODE\.VARIATION_BUSY/g) || []).length).toBe(1)
  })
})

describe('release safety', () => {
  const DIR = fileURLToPath(new URL('..', import.meta.url))
  const envFiles = readdirSync(DIR).filter(f => /^\.env\.[a-z0-9-]+$/.test(f) && f !== '.env.local')
  const valueOf = (file, key) => (readFileSync(join(DIR, file), 'utf8').split('\n').find(l => l.startsWith(`${key}=`)) ?? '').slice(key.length + 1).trim()

  it('the switch DEFAULTS TO OFF in code (fail closed) and every project env file states it explicitly', () => {
    expect(src('lib/params.js')).toContain("export const VARIATION_PROCESSING_ENABLED = defineBoolean('VARIATION_PROCESSING_ENABLED', { default: false })")
    expect(envFiles).toEqual(expect.arrayContaining(['.env.constrapp-69b5d', '.env.demo-constrap-test']))
    for (const f of envFiles) expect(['true', 'false'], f).toContain(valueOf(f, 'VARIATION_PROCESSING_ENABLED'))
  })

  it('THE PRODUCTION CUTOVER STARTS WITH THE SWITCH OFF; it is ON for the emulator', () => {
    expect(valueOf('.env.constrapp-69b5d', 'VARIATION_PROCESSING_ENABLED')).toBe('false')
    expect(valueOf('.env.demo-constrap-test', 'VARIATION_PROCESSING_ENABLED')).toBe('true')
  })

  it('adding the switch changed no existing production parameter', () => {
    expect(valueOf('.env.constrapp-69b5d', 'TEAM_MANAGEMENT_ENABLED')).toBe('true')
    expect(valueOf('.env.constrapp-69b5d', 'FILE_LINK_REVOCATION_ENABLED')).toBe('true')
    expect(valueOf('.env.constrapp-69b5d', 'FILE_LINK_RECONCILE_INTERVAL_HOURS')).toBe('2')
    expect(valueOf('.env.constrapp-69b5d', 'FINAL_ACCOUNT_APPROVAL_ENABLED')).toBe('true')
    expect(valueOf('.env.constrapp-69b5d', 'BOQ_BUDGET_TRANSFER_ENABLED')).toBe('true')
    expect(valueOf('.env.constrapp-69b5d', 'CLIENT_FINANCE_POSTING_ENABLED')).toBe('true')
    expect(valueOf('.env.constrapp-69b5d', 'CLIENT_RECEIPT_POSTING_ENABLED')).toBe('true')
    expect(valueOf('.env.constrapp-69b5d', 'CLIENT_RECEIPT_ALL_COMPANIES')).toBe('true')
    expect(valueOf('.env.constrapp-69b5d', 'STORAGE_BUCKET')).toBe('')
  })
})
