import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as client from '../../src/lib/finalAccount'
import * as server from '../../functions/src/generated/finalAccountCalc.js'
import { buildCalcBundle, CALC_BUNDLE_PATH, CALC_BUNDLE_HEADER } from '../../scripts/build-final-account-bundle.mjs'
import { readyProject, sourcesOf, FA_CURRENCY } from '../fixtures/finalAccountProject'

// ── The server's copy of the Final Account calculation (ADR-77) ──────────────
//
// `functions/src/generated/finalAccountCalc.js` is what the trusted
// approveFinalAccount callable runs. These tests are the guarantee that it is
// the SAME calculation the browser runs:
//   1. FRESH — regenerating it from src/lib/finalAccount.js yields the
//      committed bytes (a source change without `npm run functions:calc` fails);
//   2. SELF-CONTAINED — no import of any kind, no browser or Firebase reference;
//   3. EQUAL — for a ready project and for every way a project can fail the
//      readiness gate, both modules return deeply equal results.

const read = (rel) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8')
const BUNDLE = readFileSync(CALC_BUNDLE_PATH, 'utf8')

const PROJECT = { id: 'p1', name: 'Harbour Road Units' }
const args = (p, sourceStates) => ({ project: PROJECT, currencyCode: FA_CURRENCY, sources: sourcesOf(p), sourceStates })
const mutate = (fn) => { const p = readyProject(); fn(p); return p }

const VARIANTS = {
  ready: p => p,
  noContract: p => { p.baseline = null },
  workingBudget: p => { p.pointer = null },
  brokenBudget: p => { p.budgetApprovalSnapshots[0].total = 1 },
  pendingClientVariation: p => p.variations.push({ id: 'v2', variationType: 'client', status: 'submitted', submittedSubtotal: 900, lineItems: [] }),
  unappliedSupplierVariation: p => p.variations.push({ id: 'va', variationType: 'supplier', status: 'approved', approvedSubtotal: 50, lineItems: [{ costCodeId: 'cc1', approvedAmount: 50 }] }),
  openClaim: p => p.progressClaims.push({ id: 'cl', status: 'submitted', poId: 'po1', lineItems: [{ costCodeId: 'cc1', poLineIndex: 0, claimedThisPeriod: 10 }] }),
  unpostedInvoice: p => p.supplierInvoices.push({ ...p.supplierInvoices[0], id: 'inv2', status: 'draft' }),
  costToComplete: p => p.forecastLines.push({ id: 'cc1', costCodeId: 'cc1', uncommittedCostToComplete: 100.1 }),
  openCommitment: p => { p.purchaseOrders[0].lineItems[1].lineTotal = 2600.55 },
  creditNote: p => p.supplierCreditNotes.push({
    id: 'cn1', creditNumber: 'SCN-0001', status: 'posted', docType: 'credit_note', supplierInvoiceId: 'inv1', invoiceNumber: 'SI-0001',
    supplierInvoiceNumber: 'INV-100', supplierId: 'sup1', supplierName: 'Ace Concrete', creditDate: '2026-10-01', reason: 'Over-claimed',
    lineItems: [{ costCodeId: 'cc1', costCodeName: '03-100 — Concrete', amount: 100, taxCode: 'gst', gstAmount: 10 }],
    subtotal: 100, gstTotal: 10, grossTotal: 110, currency: 'AUD' }),
  retentionReleased: p => p.retentionReleases.push({ id: 'rr1', status: 'posted', supplierInvoiceId: 'inv1', amount: 50, gstAmount: 5, total: 55, releaseDate: '2026-10-05' }),
  adjustedBudget: p => {
    p.pointer = { ...p.pointer, adjustmentCount: 1, adjustmentNet: 250, lastAdjustmentId: 'adj1' }
    p.budgetAdjustments = [{ id: 'adj1', type: 'increase', costCodeId: 'cc1', costCodeName: '03-100 — Concrete', fromCostCodeId: null, fromCostCodeName: '',
      amount: 250, currency: 'AUD', baseApprovalId: 'ba1', baseVersion: 1, sequence: 1, status: 'approved' }]
  },
  overAllocatedInvoice: p => p.clientReceipts.push({ id: 'cr2', receiptNumber: 'CR-0002', status: 'posted', clientId: 'c1', receiptDate: '2026-10-20', amount: 2200.01, allocatedTotal: 2200.01, unallocatedAmount: 0, allocations: [{ clientInvoiceId: 'ci1', allocatedAmount: 2200.01 }] }),
  empty: p => { for (const k of ['purchaseOrders', 'supplierInvoices', 'supplierPayments', 'clientInvoices', 'clientReceipts', 'variations']) p[k] = [] },
}

describe('the generated bundle is fresh', () => {
  it('regenerating from src/lib/finalAccount.js yields the committed file, byte for byte', async () => {
    expect(await buildCalcBundle()).toBe(BUNDLE)
  })

  it('the build is deterministic (two builds are identical)', async () => {
    expect(await buildCalcBundle()).toBe(await buildCalcBundle())
  })

  it('carries the generated-file header and a build + check script', () => {
    expect(BUNDLE.startsWith(CALC_BUNDLE_HEADER)).toBe(true)
    const pkg = JSON.parse(read('package.json'))
    expect(pkg.scripts['functions:calc']).toBe('node scripts/build-final-account-bundle.mjs')
    expect(pkg.scripts['functions:calc:check']).toBe('node scripts/build-final-account-bundle.mjs --check')
  })
})

describe('the generated bundle is self-contained', () => {
  const code = BUNDLE.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')

  it('has no import, require or dynamic import', () => {
    expect(code).not.toMatch(/^\s*import\s/m)
    expect(code).not.toMatch(/\brequire\(|\bimport\(/)
    expect((code.match(/^export \{/gm) || []).length).toBe(1)
  })

  it('references no browser, React, Firebase or build-time global', () => {
    expect(code).not.toMatch(/import\.meta|\bwindow\.|\bdocument\.|localStorage|sessionStorage|navigator\./)
    expect(code).not.toMatch(/from ['"]firebase|firebase\/(app|firestore|auth|functions|storage)|from ['"]react/)
    expect(BUNDLE).not.toMatch(/\/Users\/|[A-Z]:\\\\/)   // no absolute path of the build machine
  })

  it('the source module itself imports only sibling lib modules', () => {
    const imports = [...read('src/lib/finalAccount.js').matchAll(/from '([^']+)'/g)].map(m => m[1])
    expect(imports.length).toBeGreaterThan(8)
    for (const i of imports) expect(i).toMatch(/^\.\/[A-Za-z]+$/)
  })

  it('exports the same names as the source module', () => {
    expect(Object.keys(server).sort()).toEqual(Object.keys(client).sort())
  })
})

describe('server and client calculations are equal', () => {
  it.each(Object.keys(VARIANTS))('%s — identical result from both modules', (name) => {
    const p = mutate(VARIANTS[name])
    const a = args(p, client.settledSourceStates())
    const c = client.computeFinalAccount(a)
    const s = server.computeFinalAccount(a)
    expect(s).toEqual(c)
    expect(JSON.stringify(s)).toBe(JSON.stringify(c))
    expect(server.blockerCodes(s)).toEqual(client.blockerCodes(c))
  })

  it('the ready variant is ready and at least ten variants are not — the comparison is not vacuous', () => {
    const ready = Object.keys(VARIANTS).filter(n => client.computeFinalAccount(args(mutate(VARIANTS[n]), client.settledSourceStates())).ready)
    expect(ready).toEqual(expect.arrayContaining(['ready', 'adjustedBudget']))
    expect(Object.keys(VARIANTS).length - ready.length).toBeGreaterThanOrEqual(9)
    // The over-allocation rule is in the SERVER's copy: the callable enforces it independently.
    expect(server.blockerCodes(server.computeFinalAccount(args(mutate(VARIANTS.overAllocatedInvoice), server.settledSourceStates())))).toEqual(['overAllocatedInvoices'])
  })

  it('failed and loading sources are judged identically', () => {
    for (const state of [{ loading: false, error: true }, { loading: true, error: false }]) {
      const a = args(readyProject(), { ...client.settledSourceStates(), supplierInvoices: state })
      expect(server.computeFinalAccount(a)).toEqual(client.computeFinalAccount(a))
    }
  })

  it('agreement, content, size and currency helpers agree', () => {
    const a = args(readyProject(), client.settledSourceStates())
    const c = client.computeFinalAccount(a)
    const draft = { ...client.finalAccountContent(c), status: 'draft' }
    expect(server.draftAgreesWith(draft, server.computeFinalAccount(a))).toBe(true)
    expect(server.draftAgreesWith({ ...draft, figures: { ...draft.figures, finalProfit: 1 } }, server.computeFinalAccount(a))).toBe(false)
    expect(server.finalAccountContent(server.computeFinalAccount(a))).toEqual(client.finalAccountContent(c))
    expect(server.estimateFinalAccountBytes(draft)).toBe(client.estimateFinalAccountBytes(draft))
    expect(server.FINAL_ACCOUNT_MAX_BYTES).toBe(client.FINAL_ACCOUNT_MAX_BYTES)
    expect(server.FINAL_ACCOUNT_APPROVE_ROLES).toEqual(['company_admin', 'project_manager'])
    for (const [proj, co] of [[{ currency: 'NZD' }, { baseCurrency: 'AUD' }], [{}, { baseCurrency: 'USD' }], [{}, {}]]) {
      expect(server.resolveProjectCurrency(proj, co)).toBe(client.resolveProjectCurrency(proj, co))
    }
  })
})

describe('the trusted backend surface', () => {
  const index = read('functions/src/index.js')
  const approve = read('functions/src/finalAccount/approve.js')
  const handlers = read('functions/src/finalAccount/handlers.js')

  it('ONE new callable: App Check enforced, the one region, no secret, no HTTP surface', () => {
    expect(index).toContain('export const approveFinalAccount = onCall(FINAL_ACCOUNT_CALL_OPTIONS')
    const opts = index.slice(index.indexOf('export const FINAL_ACCOUNT_CALL_OPTIONS'), index.indexOf('let finalAccountHandlers'))
    expect(opts).toMatch(/enforceAppCheck:\s*true/)
    expect(opts).toMatch(/region:\s*REGION/)
    expect(opts).not.toMatch(/secrets|serviceAccount/)
    expect((index.match(/onCall\(/g) || []).length).toBe(3)   // the team wrapper, this one, and transferBoqToBudget (ADR-81)
    expect(index).not.toMatch(/onRequest\(/)
  })

  it('the request schema is identifiers and guards only — an amount key is refused', () => {
    expect(handlers).toContain("const KEYS = ['projectId', 'number', 'expectedRevision', 'acknowledged']")
    expect(handlers).toMatch(/Object\.keys\(data\)\.some\(k => !KEYS\.includes\(k\)\)/)
  })

  it('the calculation is the generated bundle, the company comes from the membership, and every read is transactional', () => {
    expect(approve).toContain("import * as calc from '../generated/finalAccountCalc.js'")
    expect(approve).toContain('const companyId = profile.companyId')
    expect(approve).not.toMatch(/companyId\s*[:=]\s*(request|data|input)\b/)
    const code = approve.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
    // No read outside the transaction: every .get( in the operation is tx.get / tx.getAll.
    expect(code.match(/[^x.]\.get\(/g)).toBeNull()
    expect(code).toMatch(/tx\.getAll\(companyRef, projectRef, accountRef\)/)
    expect(code).not.toMatch(/roundMoney|toFixed|\breduce\(/)   // no arithmetic of its own
    expect(code).toContain('calc.computeFinalAccount(')
    expect(code).toContain('calc.draftAgreesWith(account, computation)')
  })

  it('the registers are read with the same ordering the browser hooks use', () => {
    const hook = read('src/hooks/useFinalAccounts.jsx')
    for (const name of ['budgetLines', 'purchaseOrders', 'progressClaims', 'supplierInvoices', 'supplierCreditNotes', 'variations', 'supplierPayments', 'retentionReleases', 'clientInvoices', 'clientReceipts']) {
      expect(approve, name).toContain(`'${name}'`)
      expect(hook, name).toContain(`${name}: ordered('${name}')`)
      expect(read(`src/hooks/use${name[0].toUpperCase()}${name.slice(1)}.jsx`), name).toMatch(/orderBy\('createdAt', 'desc'\)/)
    }
    expect(approve).toContain("orderBy('createdAt', 'desc')")
    expect(approve).toContain("orderBy('code', 'asc')")
    expect(approve).toContain("where('baseApprovalId', '==', activeId)")
  })
})

describe('the Rules block (source)', () => {
  const rules = read('firestore.rules')
  const start = rules.indexOf('match /companies/{companyId}/projects/{projectId}/finalAccounts/{faId} {')
  const block = rules.slice(start, rules.indexOf('// BOQ items', start))

  it('exists once, denies delete and has NO client path to approved', () => {
    expect(start).toBeGreaterThan(0)
    expect(rules.split('/finalAccounts/{faId}').length - 1).toBe(1)
    expect(block).toContain('allow delete: if false;')
    const update = block.slice(block.indexOf('allow update:'), block.indexOf('allow delete:'))
    expect(update).toContain("request.resource.data.status == 'withdrawn'")
    expect(update).toContain("resource.data.status == 'draft'")
    expect(update).not.toMatch(/'approved'/)
    expect(block).toContain("d.status == 'draft' && d.revision == 1")
    expect((block.match(/allow update/g) || []).length).toBe(1)
    expect((block.match(/allow create/g) || []).length).toBe(1)
  })

  it('the transitional ruleset carries the identical block', () => {
    expect(read('firestore.transitional.rules')).toContain(block)
  })
})
