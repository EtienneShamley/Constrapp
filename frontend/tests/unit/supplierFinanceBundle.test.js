import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as client from '../../src/lib/supplierFinanceCalc'
import * as server from '../../functions/src/generated/supplierFinanceCalc.js'
import { buildSupplierFinanceBundle, SUPPLIER_FINANCE_BUNDLE_PATH, SUPPLIER_FINANCE_BUNDLE_HEADER } from '../../scripts/build-supplier-finance-bundle.mjs'
import { claimTotalsFor, claimTotals } from '../../src/lib/progressClaims'
import { invoiceTotalsFor, invoiceTotals } from '../../src/lib/supplierInvoices'
import {
  createClaimRequestProblem, approveClaimRequestProblem, poClaimLedgersFromHistory, claimSubmittedSideProblem, emptyPoClaimLedger,
} from '../../src/lib/claimProcessing'
import { createInvoiceRequestProblem, invoiceStoredProblem, apportionClaimSourcedGst } from '../../src/lib/supplierInvoiceProcessing'
import { paymentDraftRequestProblem, latestPostableDate } from '../../src/lib/supplierSettlementProcessing'

// ── The supplier-finance domain (ADR-93 / ADR-94) ────────────────────────────

const read = (rel) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8')
const BUNDLE = readFileSync(SUPPLIER_FINANCE_BUNDLE_PATH, 'utf8')
const stripComments = (src) => src.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')

// ORACLE — integers only; shares no code with the modules.
const halfUp = (c) => (c < 0 ? -Math.floor((-c + 5) / 10) : Math.floor((c + 5) / 10))

describe('the generated bundle: fresh, self-contained, equal, and the only source of figures', () => {
  it('regenerating yields the committed file; the build and check scripts exist and CI runs the check', async () => {
    expect(await buildSupplierFinanceBundle()).toBe(BUNDLE)
    expect(BUNDLE.startsWith(SUPPLIER_FINANCE_BUNDLE_HEADER)).toBe(true)
    const pkg = JSON.parse(read('package.json'))
    expect(pkg.scripts['functions:supplier-finance-calc:check']).toBe('node scripts/build-supplier-finance-bundle.mjs --check')
    expect(read('../azure-pipelines.yml')).toContain('- script: npm run functions:supplier-finance-calc:check')
  })
  it('has no import and references no browser or Firebase API', () => {
    const code = stripComments(BUNDLE)
    expect(code).not.toMatch(/^\s*import\s/m)
    expect(code).not.toMatch(/\brequire\(|\bimport\(/)
    expect(code).not.toMatch(/import\.meta|\bwindow\.|\bdocument\.|localStorage|navigator\./)
    expect(code).not.toMatch(/from ['"]firebase|from ['"]react/)
    expect(BUNDLE).not.toMatch(/\/Users\/|[A-Z]:\\\\/)
  })
  it('exports exactly what the entry module exports, and the same functions compute the same results', () => {
    expect(Object.keys(server).sort()).toEqual(Object.keys(client).sort())
    const lines = [{ costCodeId: 'a', taxCode: 'gst', amount: 40.15, gstAmount: 4.02 }]
    expect(server.invoiceTotalsFor === undefined).toBe(true)  // not re-exported: totals reach the server only through the processing modules
    expect(server.supplierLedgersFromHistory({ invoices: {}, payments: [] })).toEqual(client.supplierLedgersFromHistory({ invoices: {}, payments: [] }))
    expect(server.apportionClaimSourcedGst(lines, { certifiedGst: 4.02, retention: 0, version: 2 })).toEqual(client.apportionClaimSourcedGst(lines, { certifiedGst: 4.02, retention: 0, version: 2 }))
  })
  it('functions/src/supplierFinance contains no money arithmetic of its own (no rate, no rounding)', () => {
    const dir = fileURLToPath(new URL('../../functions/src/supplierFinance/', import.meta.url))
    for (const f of readdirSync(dir)) {
      const src = stripComments(readFileSync(dir + f, 'utf8'))
      expect(src, f).not.toMatch(/0\.1\b|GST_RATE|toFixed|Math\.floor\(|roundMoney/)
    }
  })
})

describe('ADR-91 — claim and invoice totals under each version, against the oracle', () => {
  it('LEGACY is the existing function, to the byte, across 20,000 cent values', () => {
    for (let c = -10000; c <= 10000; c += 1) {
      const a = c / 100
      expect(claimTotalsFor([a], 0, 1)).toEqual(claimTotals([a], 0))
      expect(invoiceTotalsFor([{ amount: 100, gstAmount: 10 }], Math.abs(a), 1)).toEqual(invoiceTotals([{ amount: 100, gstAmount: 10 }], Math.abs(a)))
    }
  })
  it('EXACT: claim GST is half-up 10% of the NET cents; invoice retention GST is half-up 10% of the retained cents', () => {
    for (let sub = 0; sub <= 200000; sub += 7) {
      const ret = Math.floor(sub / 3)
      const t = claimTotalsFor([sub / 100], ret / 100, 2)
      const net = sub - ret
      expect(Math.round(t.gst * 100), `claim ${sub}/${ret}`).toBe(halfUp(net))
      expect(Math.round(t.total * 100)).toBe(net + halfUp(net))
      const i = invoiceTotalsFor([{ amount: sub / 100, gstAmount: halfUp(sub) / 100 }], ret / 100, 2)
      expect(Math.round(i.retentionGst * 100), `invoice ${sub}/${ret}`).toBe(halfUp(ret))
      expect(Math.round(i.payableTotal * 100)).toBe(sub + halfUp(sub) - ret - halfUp(ret))
    }
  })
  it('where they differ: 40.15 net — legacy GST 4.01, exact 4.02', () => {
    expect(claimTotalsFor([40.15], 0, 1).gst).toBe(4.01)
    expect(claimTotalsFor([40.15], 0, 2).gst).toBe(4.02)
    expect(claimTotalsFor([1], 0, 7)).toBeNull()
  })
})

describe('request contracts — authored content only', () => {
  const claimReq = (o = {}) => ({ projectId: 'p', claimId: 'c', poId: 'po', periodEnding: '', claimRef: '', notes: '', retention: 0,
    lines: [{ poLineIndex: 0, variationId: null, variationLineIndex: null, claimedToDate: 1 }], ...o })
  it('a claim create refuses a derived key, a negative or sub-cent retention, a line with two sources or none', () => {
    expect(createClaimRequestProblem(claimReq())).toBeNull()
    expect(createClaimRequestProblem({ ...claimReq(), claimedGst: 1 })).toBe('keys')
    expect(createClaimRequestProblem(claimReq({ retention: -1 }))).toBe('retention')
    expect(createClaimRequestProblem(claimReq({ retention: 1.005 }))).toBe('retention')
    expect(createClaimRequestProblem(claimReq({ lines: [{ poLineIndex: 0, variationId: 'v', variationLineIndex: 0, claimedToDate: 1 }] }))).toBe('line-source')
    expect(createClaimRequestProblem(claimReq({ lines: [{ poLineIndex: null, variationId: null, variationLineIndex: null, claimedToDate: 1 }] }))).toBe('line-source')
    expect(approveClaimRequestProblem({ projectId: 'p', claimId: 'c', expectedRevision: 2, approvedAmounts: [-1], assessmentNotes: '' })).toBe('approvedAmounts')
  })
  it('an invoice create: claim-sourced carries no amount and no retention; a line names each source line once', () => {
    const base = { projectId: 'p', invoiceId: 'i', source: 'progress_claim', sourceId: 'c', expectedSourceRevision: 3,
      supplierInvoiceNumber: 'X', invoiceDate: '2026-11-28', receivedDate: '', dueDate: '', notes: '', retention: null,
      lines: [{ lineIndex: 0, amount: null, taxCode: 'gst' }] }
    expect(createInvoiceRequestProblem(base)).toBeNull()
    expect(createInvoiceRequestProblem({ ...base, lines: [{ lineIndex: 0, amount: 5, taxCode: 'gst' }] })).toBe('line-amount')
    expect(createInvoiceRequestProblem({ ...base, retention: 0 })).toBe('retention')
    expect(createInvoiceRequestProblem({ ...base, lines: [{ lineIndex: 0, amount: null, taxCode: 'gst' }, { lineIndex: 0, amount: null, taxCode: 'gst' }] })).toBe('line-index')
    expect(createInvoiceRequestProblem({ ...base, payableTotal: 1 })).toBe('keys')
  })
  it('a payment: allocations never exceed its amount, never twice to one invoice', () => {
    const p = { projectId: 'p', paymentId: 'x', expectedRevision: null, supplierId: 's', paymentDate: '2026-11-28', amount: 10, paymentMethod: 'bank_transfer',
      paymentMethodOther: '', bankReference: '', remittanceReference: '', externalReference: '', notes: '', allocations: [{ supplierInvoiceId: 'i', allocatedAmount: 10 }] }
    expect(paymentDraftRequestProblem(p)).toBeNull()
    expect(paymentDraftRequestProblem({ ...p, allocations: [{ supplierInvoiceId: 'i', allocatedAmount: 10.01 }] })).toBe('allocations-exceed-amount')
    expect(paymentDraftRequestProblem({ ...p, allocations: [{ supplierInvoiceId: 'i', allocatedAmount: 5 }, { supplierInvoiceId: 'i', allocatedAmount: 5 }] })).toBe('allocation-duplicate')
    expect(latestPostableDate(Date.parse('2026-11-28T23:30:00Z'))).toBe('2026-11-29')
  })
})

describe('claim ledgers and verification', () => {
  it('the per-PO baseline: open claims, certified amounts per PO line and variation line; several open claims make that PO inconsistent', () => {
    const { ledgers } = poClaimLedgersFromHistory([
      { id: 'a', poId: 'p1', status: 'approved', lineItems: [{ poLineIndex: 0, approvedThisPeriod: 10.5 }, { variationId: 'v', variationLineIndex: 2, approvedThisPeriod: 1 }] },
      { id: 'b', poId: 'p1', status: 'invoiced', lineItems: [{ poLineIndex: 0, approvedThisPeriod: 0.25 }] },
      { id: 'c', poId: 'p1', status: 'draft', lineItems: [] },
      { id: 'd', poId: 'p2', status: 'submitted', lineItems: [] },
      { id: 'e', poId: 'p2', status: 'draft', lineItems: [] },
      { id: 'f', poId: 'p1', status: 'rejected', lineItems: [{ poLineIndex: 0, approvedThisPeriod: 999 }] },
    ])
    expect(ledgers.get('p1')).toMatchObject({ state: 'established', ledger: { openClaimIds: ['c'], approvedPoLineCents: { 0: 1075 }, approvedVariationLineCents: { 'v:2': 100 } } })
    expect(ledgers.get('p2')).toMatchObject({ state: 'inconsistent', problemKind: 'open-claims' })
    expect(poClaimLedgersFromHistory([{ id: 'x', status: 'draft' }]).problem).toMatch(/names no purchase order/)
  })

  it('an unknown calculation version or a missing PO line refuses certification', () => {
    const po = { id: 'p', status: 'sent', lineItems: [{ costCodeId: 'cc' }] }
    const claim = { id: 'c', poId: 'p', calcVersion: 9, lineItems: [] }
    expect(claimSubmittedSideProblem({ claim, po, variations: [], ledger: emptyPoClaimLedger() }).reason).toBe('version')
    expect(claimSubmittedSideProblem({ claim: { ...claim, calcVersion: 2, lineItems: [] }, po, variations: [], ledger: emptyPoClaimLedger() }).reason).toBe('lines')
  })
})

describe('claim-sourced invoices — the certified GST is apportioned, never recomputed', () => {
  it('three certified lines of 10.05: the claim certified 3.02 on the net, the lines carry 3.02 between them', () => {
    const lines = [0, 1, 2].map(i => ({ poLineIndex: i, costCodeId: 'a', amount: 10.05, taxCode: 'gst', gstAmount: 0 }))
    const out = apportionClaimSourcedGst(lines, { certifiedGst: 3.02, retention: 0, version: 2 })
    expect(out.reduce((s, l) => s + Math.round(l.gstAmount * 100), 0)).toBe(302)
  })
  it('a stored claim-sourced invoice whose payable total is not the claim’s is refused at verification', () => {
    const claim = { id: 'c', poId: 'p', status: 'approved', supplierId: 's', retention: 0, approvedGst: 1, approvedTotal: 11, lineItems: [{ poLineIndex: 0, costCodeId: 'a', approvedThisPeriod: 10 }] }
    const invoice = {
      source: 'progress_claim', progressClaimId: 'c', poId: 'p', supplierId: 's', calcVersion: 2,
      lineItems: [{ poLineIndex: 0, costCodeId: 'a', amount: 10, taxCode: 'gst', gstAmount: 1 }],
      subtotal: 10, gstTotal: 1, grossTotal: 11, retention: 0, retentionGst: 0, retentionTotal: 0, net: 10, payableGst: 1, payableTotal: 11,
    }
    expect(invoiceStoredProblem({ invoice, claim, po: null })).toBeNull()
    expect(invoiceStoredProblem({ invoice: { ...invoice, payableTotal: 12, grossTotal: 12, gstTotal: 2, payableGst: 2, lineItems: [{ ...invoice.lineItems[0], gstAmount: 2 }] }, claim, po: null }).reason).toBe('claim-totals')
  })
})
