import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as client from '../../src/lib/boqBudgetTransfer'
import * as server from '../../functions/src/generated/boqBudgetTransferCalc.js'
import { buildTransferBundle, TRANSFER_BUNDLE_PATH, TRANSFER_BUNDLE_HEADER } from '../../scripts/build-boq-transfer-bundle.mjs'
import { boqLineAmount } from '../../src/lib/boq'

// ── The server's copy of the BOQ transfer proposal (ADR-81) ──────────────────
//
// `functions/src/generated/boqBudgetTransferCalc.js` is what the trusted
// transferBoqToBudget callable runs. These tests are the guarantee that it is
// the SAME module the browser runs: FRESH (regenerating yields the committed
// bytes), SELF-CONTAINED (no import of any kind) and EQUAL (same proposal,
// same keys, same operations for every state a cost code can be in).

const read = (rel) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8')
const BUNDLE = readFileSync(TRANSFER_BUNDLE_PATH, 'utf8')

const CODES = [
  { id: 'cc1', code: '03-100', name: 'Concrete', isActive: true },
  { id: 'cc2', code: '05-100', name: 'Steel', isActive: true },
  { id: 'cc3', code: '09-100', name: 'Finishes', isActive: true },
  { id: 'cc4', code: '10-100', name: 'Fitout', isActive: true },
  { id: 'ccOff', code: '99-000', name: 'Retired', isActive: false },
]
const item = (id, costCodeId, quantity, rate, over = {}) => ({
  id, status: 'active', costCodeId, costCodeName: costCodeId, unit: 'm2', quantity, rate, amount: boqLineAmount(quantity, rate), currency: 'AUD', ...over,
})
const sourced = (cc, budgeted) => ({ id: `boq-${cc}`, costCodeId: cc, costCodeName: cc, budgeted, boqSource: { first: { amount: budgeted }, latest: { amount: budgeted, transferCount: 1 } } })

const VARIANTS = {
  empty: { boqItems: [], budgetLines: [] },
  create: { boqItems: [item('a', 'cc1', 2, 50), item('b', 'cc2', 3, 0)], budgetLines: [] },
  refreshAndUnchanged: { boqItems: [item('a', 'cc1', 2, 50), item('b', 'cc2', 1, 9.99)], budgetLines: [sourced('cc1', 80), sourced('cc2', 9.99)] },
  unpriced: { boqItems: [item('a', 'cc1', 2, 50), item('b', 'cc1', 1, null)], budgetLines: [] },
  manualLine: { boqItems: [item('a', 'cc1', 2, 50)], budgetLines: [{ id: 'm1', costCodeId: 'cc1', costCodeName: 'cc1', budgeted: 70 }] },
  multipleLines: { boqItems: [item('a', 'cc1', 2, 50)], budgetLines: [sourced('cc1', 80), { id: 'm1', costCodeId: 'cc1', budgeted: 5 }] },
  voidedSource: { boqItems: [item('a', 'cc1', 2, 50, { status: 'void' })], budgetLines: [sourced('cc1', 100)] },
  currency: { boqItems: [item('a', 'cc1', 2, 50, { currency: 'NZD' })], budgetLines: [] },
  codes: { boqItems: [item('a', 'ccOff', 2, 50), item('b', 'ccGone', 1, 1)], budgetLines: [] },
  invalid: { boqItems: [item('a', 'cc1', 2, 50, { amount: 1 })], budgetLines: [sourced('cc2', 'x')] },
  mixed: {
    boqItems: [item('a', 'cc1', 2, 50), item('b', 'cc2', 3, 12.34), item('c', 'cc3', 1, null), item('d', 'cc4', 1, 1, { status: 'void' })],
    budgetLines: [sourced('cc2', 30), sourced('cc4', 400), { id: 'm9', costCodeId: 'cc3', budgeted: 12 }],
  },
}
const args = (v) => ({ ...v, costCodes: CODES, currencyCode: 'AUD' })

describe('the generated bundle is fresh', () => {
  it('regenerating from src/lib/boqBudgetTransfer.js yields the committed file, byte for byte', async () => {
    expect(await buildTransferBundle()).toBe(BUNDLE)
  })
  it('the build is deterministic, carries the generated-file header, and has a build + check script', async () => {
    expect(await buildTransferBundle()).toBe(await buildTransferBundle())
    expect(BUNDLE.startsWith(TRANSFER_BUNDLE_HEADER)).toBe(true)
    const pkg = JSON.parse(read('package.json'))
    expect(pkg.scripts['functions:transfer-calc']).toBe('node scripts/build-boq-transfer-bundle.mjs')
    expect(pkg.scripts['functions:transfer-calc:check']).toBe('node scripts/build-boq-transfer-bundle.mjs --check')
  })
})

describe('the generated bundle is self-contained', () => {
  const code = BUNDLE.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
  it('has no import, require or dynamic import, and one export statement', () => {
    expect(code).not.toMatch(/^\s*import\s/m)
    expect(code).not.toMatch(/\brequire\(|\bimport\(/)
    expect((code.match(/^export \{/gm) || []).length).toBe(1)
  })
  it('references no browser, React, Firebase or build-time global, and no clock', () => {
    expect(code).not.toMatch(/import\.meta|\bwindow\.|\bdocument\.|localStorage|sessionStorage|navigator\./)
    expect(code).not.toMatch(/from ['"]firebase|firebase\/(app|firestore|auth|functions|storage)|from ['"]react/)
    expect(BUNDLE).not.toMatch(/\/Users\/|[A-Z]:\\\\/)
    const source = read('src/lib/boqBudgetTransfer.js').split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
    expect(source).not.toMatch(/Date\.now|new Date|Math\.random|serverTimestamp/)
  })
  it('the source module imports only sibling lib modules, and both export the same names', () => {
    const imports = [...read('src/lib/boqBudgetTransfer.js').matchAll(/from '([^']+)'/g)].map(m => m[1])
    expect(imports.sort()).toEqual(['./boq', './costCodes', './currency', './payments'])
    expect(Object.keys(server).sort()).toEqual(Object.keys(client).sort())
  })
})

describe('server and client proposals are equal', () => {
  it.each(Object.keys(VARIANTS))('%s — identical proposal, key, operations, summary and result key', (name) => {
    const a = args(VARIANTS[name])
    const c = client.buildTransferProposal(a)
    const s = server.buildTransferProposal(a)
    expect(s).toEqual(c)
    expect(JSON.stringify(s)).toBe(JSON.stringify(c))
    const zero = c.rows.filter(r => r.state === client.TRANSFER_ROW_STATE.ZERO_AVAILABLE).map(r => r.costCodeId)
    for (const z of [[], zero]) {
      expect(server.transferOperations(s, z)).toEqual(client.transferOperations(c, z))
      expect(server.transferSummary(s, z)).toEqual(client.transferSummary(c, z))
      expect(server.transferRequestKey(s.reviewKey, z)).toBe(client.transferRequestKey(c.reviewKey, z))
      const ops = client.transferOperations(c, z).operations
      expect(server.resultKeyAfter(a, ops)).toBe(client.resultKeyAfter(a, ops))
    }
  })
  it('the comparison is not vacuous: every row state and every blocker appears in the variants', () => {
    const rows = Object.values(VARIANTS).flatMap(v => client.buildTransferProposal(args(v)).rows)
    expect(new Set(rows.map(r => r.state))).toEqual(new Set(Object.values(client.TRANSFER_ROW_STATE)))
    expect(new Set(rows.flatMap(r => r.blockers))).toEqual(new Set(Object.values(client.TRANSFER_BLOCKER)))
  })
  it('constants and currency resolution agree', () => {
    expect(server.BOQ_TRANSFER_ROLES).toEqual(['company_admin', 'project_manager', 'qs'])
    expect(server.BOQ_TRANSFER_REQUEST_KEYS).toEqual(['projectId', 'reviewKey', 'setToZero'])
    expect(server.TRANSFER_OUTCOME).toEqual(client.TRANSFER_OUTCOME)
    for (const [proj, co] of [[{ currency: 'NZD' }, { baseCurrency: 'AUD' }], [{}, { baseCurrency: 'USD' }], [{}, {}]]) {
      expect(server.resolveProjectCurrency(proj, co)).toBe(client.resolveProjectCurrency(proj, co))
    }
  })
})

describe('the trusted backend surface', () => {
  const index = read('functions/src/index.js')
  const transfer = read('functions/src/boqBudget/transfer.js')
  const handlers = read('functions/src/boqBudget/handlers.js')
  const code = transfer.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')

  it('ONE more callable: App Check enforced, the one region, no secret, no HTTP surface', () => {
    expect(index).toContain('export const transferBoqToBudget = onCall(BOQ_TRANSFER_CALL_OPTIONS')
    const opts = index.slice(index.indexOf('export const BOQ_TRANSFER_CALL_OPTIONS'), index.indexOf('let boqBudgetHandlers'))
    expect(opts).toMatch(/enforceAppCheck:\s*true/)
    expect(opts).toMatch(/region:\s*REGION/)
    expect(opts).not.toMatch(/secrets|serviceAccount/)
    expect((index.match(/onCall\(/g) || []).length).toBe(4)   // the team wrapper, approveFinalAccount, this one and the client-finance wrapper (ADR-89)
    expect(index).not.toMatch(/onRequest\(/)
  })
  it('the request schema is identifiers and guards only', () => {
    expect(client.BOQ_TRANSFER_REQUEST_KEYS).toEqual(['projectId', 'reviewKey', 'setToZero'])
    expect(handlers).toMatch(/Object\.keys\(data\)\.some\(k => !KEYS\.includes\(k\)\)/)
  })
  it('the proposal is the generated bundle, the company comes from the membership, and every read is transactional', () => {
    expect(transfer).toContain("import * as calc from '../generated/boqBudgetTransferCalc.js'")
    expect(code).toContain('const companyId = profile.companyId')
    expect(code).not.toMatch(/companyId\s*[:=]\s*(request|data|input)\b/)
    // No Firestore read outside the transaction: every .get( is tx.get, or a lookup in one of two local Maps.
    expect([...new Set([...code.matchAll(/(\w+)\.get\(/g)].map(m => m[1]))].sort()).toEqual(['existing', 'tx', 'updateTimes'])
    expect(code).toContain('const existing = new Map(')
    expect(code).toContain('const updateTimes = new Map(')
    expect(code).toMatch(/tx\.getAll\(companyRef, projectRef\)/)
    expect(code).toContain('calc.buildTransferProposal(inputs)')
    expect(code).not.toMatch(/roundMoney|toFixed|\breduce\(|Math\.round|\* 100|\/ 100/)   // no arithmetic of its own
  })
  it('it reads the three source registers whole and NEVER touches an approved-budget collection', () => {
    for (const name of ['boqItems', 'budgetLines', 'costCodes']) expect(code).toContain(`collection('${name}').limit(limit + 1)`)
    for (const name of ['budgetApprovals', 'budgetApprovalSnapshots', 'approvedBudget', 'budgetAdjustments']) expect(code).not.toContain(name)
    // The only collections written: budgetLines (create / update), the project document (currency lock) and the audit log.
    expect((code.match(/tx\.create\(/g) || []).length).toBe(1)
    expect((code.match(/tx\.update\(/g) || []).length).toBe(2)
    expect(code).not.toMatch(/tx\.(set|delete)\(/)
    expect(code).toContain('AUDIT.BOQ_BUDGET_TRANSFERRED')
  })
  it('all reads come before the first write', () => {
    const firstWrite = Math.min(...['tx.create(', 'tx.update(', 'auditInTx('].map(w => code.indexOf(w)))
    const lastRead = Math.max(code.lastIndexOf('tx.get('), code.lastIndexOf('tx.getAll('), code.lastIndexOf('readTransferSources(tx'))
    expect(lastRead).toBeGreaterThan(0)
    expect(firstWrite).toBeGreaterThan(lastRead)
  })
})

describe('the browser surface', () => {
  const page = read('src/pages/project/ProjectBoq.jsx')
  const modal = read('src/pages/project/boq/BoqBudgetTransferModal.jsx')
  const hook = read('src/hooks/useBoqBudgetTransfer.jsx')
  const actions = read('src/lib/boqBudgetTransferActions.js')
  const review = read('src/lib/boqTransferReview.js')

  it('the page and the dialog import no Firebase code; the call lives in the hook', () => {
    for (const src of [page, modal, actions, review]) expect(src).not.toMatch(/from ['"]firebase/)
    expect(hook).toContain("httpsCallable(functions, 'transferBoqToBudget'")
    expect(hook).not.toMatch(/firebase\/firestore/)
  })
  it('the request the browser builds carries no amount', () => {
    expect(actions).toContain('call({ projectId, reviewKey, setToZero: normaliseZeroChoices(setToZero) })')
    // L4 correction: the dialog builds the request through the confirmation
    // check, which returns only these two fields.
    expect(modal).toContain('transferRequestToSend({ pending, reviewKey: proposal.reviewKey, zeroChoices, confirmedFor })')
    expect(review).toContain('return { reviewKey, setToZero: normaliseZeroChoices(zeroChoices) }')
  })
  it('the dialog uses the shared write-outcome controller, requires confirmation, and starts with nothing set to zero', () => {
    expect(modal).toContain("useWriteAction('BOQ to budget transfer')")
    expect(modal).toContain('<WriteFeedback write={write} acknowledgeLabel={TRANSFER_UNCERTAIN_ACK_LABEL} />')
    expect(modal).toContain('useState(() => new Set())')
    // Confirmation is bound to the exact request (L4 correction).
    expect(modal).toContain('operationCount: summary.operationCount, confirmedFor, currentKey')
    expect(review).toContain('return operationCount > 0 && isConfirmationCurrent(confirmedFor, currentKey)')
    expect(modal).toContain('disabled={!canSubmit}')
  })
  it('no browser hook writes a BOQ-sourced line', () => {
    expect(read('src/hooks/useBudgetLines.jsx')).not.toMatch(/boqSource|boq-/)
    expect(read('src/hooks/useBoqItems.jsx')).not.toMatch(/budgetLines/)
  })
})
