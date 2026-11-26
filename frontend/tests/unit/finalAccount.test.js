import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  computeFinalAccount, settledSourceStates, readinessChecklist, blockerCodes, BLOCKER, READINESS_CHECKS,
  FINAL_ACCOUNT_FIGURES, FINAL_ACCOUNT_FIGURE_KEYS, FINAL_ACCOUNT_OPEN_KEYS, FIGURE_BASIS, FINAL_ACCOUNT_STATUS,
  FINAL_ACCOUNT_LIMITS, FINAL_ACCOUNT_MAX_BYTES, FINAL_ACCOUNT_DISCLAIMER,
  buildFinalAccountDraft, estimateFinalAccountBytes, finalAccountContent, validateFinalAccountInput,
  validateFinalAccountWithdrawReason, finalAccountDifferences, draftAgreesWith, finalAccountHistory, openItemsOf,
  canPrepareFinalAccount, canApproveFinalAccount, canWithdrawFinalAccount,
} from '../../src/lib/finalAccount'
import { finalAccountCsv, finalAccountFilename } from '../../src/lib/finalAccountCsv'
import { figureText, figurePresentation, FIGURE_VIEW, revisionView, readinessPresentation, NOT_RECORDED_NOTE } from '../../src/lib/finalAccountDisplay'
import {
  runFinalAccountApprove, runFinalAccountPrepare, runFinalAccountWithdraw, finalAccountCallableErrorKind, FINAL_ACCOUNT_ERROR,
  FINAL_ACCOUNT_ERROR_MESSAGES, APPROVE_CALL_TIMEOUT_MS, FINAL_ACCOUNT_QUERY_NAMES,
} from '../../src/lib/finalAccountActions'
import { buildCommercialReport } from '../../src/lib/commercialReport'
import { contractControl } from '../../src/lib/clientInvoices'
import { receivablesSummary } from '../../src/lib/clientReceipts'
import { retentionSummary } from '../../src/lib/retention'
import { FinalAccountFigures, FinalAccountRows } from '../../src/pages/project/finalAccount/FinalAccountSnapshot'
import { ApproveFinalAccountModal, PrepareFinalAccountModal } from '../../src/pages/project/finalAccount/FinalAccountDialogs'
import { readyProject, sourcesOf, EXPECTED_FIGURES, FA_CURRENCY } from '../fixtures/finalAccountProject'
import { issuedInvoice, creditNoteFor, releaseFor } from '../fixtures/clientReceivableDocs'
import { receivableContext } from '../../src/lib/clientReceivables'

// ── L2-B Final Account — pure domain, export and presentation (ADR-77) ───────
//
// The Final Account must be a COMPOSITION of the Commercial Report's
// selectors, gated by a readiness check, frozen at approval and compared —
// never recalculated — afterwards. Structural assertions read SOURCE (plain
// Node runner, no jsdom — ADR-26).

const read = (rel) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8')
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '')

const without = (obj, key) => Object.fromEntries(Object.entries(obj).filter(([k]) => k !== key))
const PROJECT = { id: 'p1', name: 'Harbour Road Units' }
const compute = (p = readyProject(), sourceStates = settledSourceStates()) =>
  computeFinalAccount({ project: PROJECT, currencyCode: FA_CURRENCY, sources: sourcesOf(p), sourceStates })
const mutate = (fn) => { const p = readyProject(); fn(p); return p }
const ts = (s) => ({ seconds: s, nanoseconds: 0, toDate: () => new Date(s * 1000), toMillis: () => s * 1000 })

const stored = (over = {}) => {
  const c = compute()
  return {
    id: '1', number: 1, status: 'approved', revision: 2, reason: 'Works complete', reference: 'FA-1', currency: 'AUD',
    ...finalAccountContent(c), openItemsAcknowledged: true, preparedByName: 'Quin QS',
    approvedAt: ts(1_763_000_000), approvedBy: 'u_pm', approvedByName: 'Pat PM', approvedByRole: 'project_manager', selfApproved: false,
    sourcesReadAt: ts(1_763_000_000), withdrawnAt: null, withdrawnBy: null, withdrawReason: '',
    createdAt: ts(1_762_000_000), createdBy: 'u_qs', updatedAt: ts(1_763_000_000), updatedBy: 'u_pm', ...over,
  }
}

// ── 1. Figures ───────────────────────────────────────────────────────────────

describe('figures are the existing selectors, carried through unchanged', () => {
  const c = compute()

  it('a ready project yields every figure, exactly as expected, with no blocker', () => {
    expect(c.ready).toBe(true)
    expect(c.blockers).toEqual([])
    expect(c.figures).toEqual(EXPECTED_FIGURES)
    expect(Object.keys(c.figures).sort()).toEqual([...FINAL_ACCOUNT_FIGURE_KEYS].sort())
  })

  it('headline figures equal the Commercial Report (the same composition, not a copy)', () => {
    const report = buildCommercialReport({ project: PROJECT, currencyCode: 'AUD', sources: sourcesOf(readyProject()), sourceStates: settledSourceStates() })
    const of = (section, key) => report[section].find(i => i.key === key).figure.value
    expect(c.figures.originalContractValue).toBe(of('summary', 'originalContractValue'))
    expect(c.figures.finalContractSum).toBe(of('summary', 'currentContractSum'))
    expect(c.figures.approvedBudget).toBe(of('summary', 'approvedBudget'))
    expect(c.figures.actualCost).toBe(of('summary', 'actual'))
    expect(c.figures.costToComplete).toBe(of('summary', 'costToComplete'))
    expect(c.figures.finalCost).toBe(of('summary', 'forecastFinalCost'))
    expect(c.figures.finalProfit).toBe(of('summary', 'forecastGrossProfit'))
    expect(c.figures.finalMarginPct).toBe(of('summary', 'forecastMarginPct'))
    expect(c.figures.approvedClientVariations).toBe(of('variations', 'approvedClientVariations'))
    expect(c.figures.cashReceived).toBe(of('cash', 'cashIn'))
    expect(c.figures.cashPaid).toBe(of('cash', 'cashOut'))
    expect(c.figures.receivablesOutstanding).toBe(of('cash', 'receivablesOutstanding'))
    expect(c.figures.payablesOutstanding).toBe(of('cash', 'remainingPayable'))
  })

  it('revenue and retention figures equal their own selectors', () => {
    const p = readyProject()
    const control = contractControl(p.clientInvoices, 12000)
    expect(c.figures.invoicedToClient).toBe(control.issued.subtotal)
    expect(c.figures.invoicedToClientGross).toBe(control.issued.grossTotal)
    expect(c.figures.remainingToInvoice).toBe(control.availableToInvoice)
    expect(c.figures.receivedAgainstInvoices).toBe(receivablesSummary(p.clientInvoices, p.clientReceipts).received)
    expect(c.figures.retentionHeld).toBe(retentionSummary(p.supplierInvoices, p.retentionReleases).retentionHeld)
  })

  it('contract value, certified-style, invoiced, received and outstanding are DIFFERENT figures', () => {
    const f = c.figures
    const distinct = [f.finalContractSum, f.invoicedToClient, f.invoicedToClientGross, f.receivedAgainstInvoices, f.receivablesOutstanding, f.remainingToInvoice]
    expect(new Set(distinct).size).toBe(distinct.length)
    // Actual is cost incurred; committed is gone (cost to complete 0) — never added twice.
    expect(f.finalCost).toBe(f.actualCost)
  })

  it('ex-GST and gross figures are labelled apart and no figure key mixes them', () => {
    const gross = FINAL_ACCOUNT_FIGURES.filter(f => f.basis === FIGURE_BASIS.GROSS).map(f => f.key)
    const exGst = FINAL_ACCOUNT_FIGURES.filter(f => f.basis === FIGURE_BASIS.EX_GST).map(f => f.key)
    expect(gross).toEqual(expect.arrayContaining(['invoicedToClientGross', 'receivablesOutstanding', 'cashReceived', 'cashPaid', 'payablesOutstanding', 'retentionHeld']))
    expect(exGst).toEqual(expect.arrayContaining(['finalContractSum', 'invoicedToClient', 'remainingToInvoice', 'actualCost', 'finalProfit']))
    // No "balance due" style total: nothing in the module adds a gross figure to an ex-GST one.
    const src = stripComments(read('src/lib/finalAccount.js'))
    expect(src).not.toMatch(/balanceDue|amountDue|totalOutstanding/)
    expect(src).not.toMatch(/roundMoney\([^)]*\+/)
  })

  it('pending variations are never inside the contract sum', () => {
    const p = mutate(x => x.variations.push({ id: 'v2', variationType: 'client', status: 'submitted', submittedSubtotal: 900, lineItems: [] }))
    const r = compute(p)
    expect(r.partialFigures.approvedClientVariations).toBe(2000)
    expect(r.partialFigures.finalContractSum).toBe(12000)
    expect(blockerCodes(r)).toContain(BLOCKER.CLIENT_VARIATIONS)
  })

  it('cost-code rows carry the approved budget, actual and variance per code, in a stable order', () => {
    expect(c.rows).toEqual([
      { costCodeId: 'cc1', costCodeName: '03-100 — Concrete', approvedBudget: 4000, actualCost: 3500, variance: 500 },
      { costCodeId: 'cc2', costCodeName: '03-200 — Formwork', approvedBudget: 3000, actualCost: 2500, variance: 500 },
    ])
  })

  it('provenance names the approved budget version and counts every register', () => {
    expect(c.provenance).toMatchObject({ budgetApprovalId: 'ba1', budgetVersion: 1, adjustmentCount: 0, budgetCaption: 'Approved version 1' })
    expect(c.provenance.counts).toMatchObject({ purchaseOrders: 1, supplierInvoices: 1, variations: 1, clientInvoices: 1, clientReceipts: 1, supplierPayments: 1 })
  })
})

// ── 2. Readiness ─────────────────────────────────────────────────────────────

describe('the readiness gate', () => {
  const cases = [
    [BLOCKER.CONTRACT, p => { p.baseline = null }],
    [BLOCKER.BUDGET, p => { p.pointer = null }],
    [BLOCKER.CLIENT_VARIATIONS, p => p.variations.push({ id: 'vd', variationType: 'client', status: 'draft', lineItems: [] })],
    [BLOCKER.SUPPLIER_VARIATIONS, p => p.variations.push({ id: 'vs', variationType: 'supplier', status: 'submitted', submittedSubtotal: 70, lineItems: [{ costCodeId: 'cc2', submittedAmount: 70 }] })],
    [BLOCKER.UNAPPLIED_VARIATIONS, p => p.variations.push({ id: 'va', variationType: 'supplier', status: 'approved', approvedSubtotal: 50, lineItems: [{ costCodeId: 'cc1', approvedAmount: 50 }] })],
    [BLOCKER.OPEN_CLAIMS, p => p.progressClaims.push({ id: 'cl', status: 'submitted', poId: 'po1', lineItems: [{ costCodeId: 'cc1', poLineIndex: 0, claimedThisPeriod: 10 }] })],
    [BLOCKER.UNPOSTED_INVOICES, p => p.supplierInvoices.push({ ...p.supplierInvoices[0], id: 'inv2', status: 'approved' })],
    [BLOCKER.DRAFT_CLIENT_INVOICES, p => p.clientInvoices.push({ id: 'ci2', status: 'draft', subtotal: 1, gstTotal: 0.1, grossTotal: 1.1 })],
    [BLOCKER.DRAFT_RECEIPTS, p => p.clientReceipts.push({ id: 'cr2', status: 'draft', amount: 5, allocations: [] })],
    [BLOCKER.DRAFT_PAYMENTS, p => p.supplierPayments.push({ id: 'pay2', status: 'draft', amount: 5, allocations: [] })],
    [BLOCKER.DRAFT_CREDIT_NOTES, p => p.supplierCreditNotes.push({ id: 'cn', status: 'draft', supplierInvoiceId: 'inv1', lineItems: [], subtotal: 1, gstTotal: 0.1, grossTotal: 1.1 })],
    [BLOCKER.DRAFT_RELEASES, p => p.retentionReleases.push({ id: 'rr', status: 'draft', supplierInvoiceId: 'inv1', amount: 10 })],
    [BLOCKER.DRAFT_CLIENT_CREDIT_NOTES, p => p.clientCreditNotes.push({ id: 'ccn', status: 'draft', clientInvoiceId: 'ci1', lineItems: [], subtotal: 1, gstTotal: 0.1, grossTotal: 1.1 })],
    [BLOCKER.DRAFT_CLIENT_RELEASES, p => p.clientRetentionReleases.push({ id: 'crr', status: 'draft', clientInvoiceId: 'ci1', amount: 10, gstAmount: 1, releaseTotal: 11 })],
    // A posted credit note for ANOTHER client fails the read-time gate.
    [BLOCKER.CLIENT_CREDIT_EXCEPTIONS, p => { p.clientInvoices[0] = issuedInvoice(); p.clientCreditNotes.push(creditNoteFor(p.clientInvoices[0], 100, { clientId: 'someone-else' })) }],
    // A posted release against an invoice that withheld no retention.
    [BLOCKER.CLIENT_RELEASE_EXCEPTIONS, p => p.clientRetentionReleases.push({ id: 'crr', releaseNumber: 'CRR-0009', status: 'posted', clientInvoiceId: 'ci1', amount: 10, gstAmount: 1, releaseTotal: 11 })],
    [BLOCKER.COST_TO_COMPLETE, p => p.forecastLines.push({ id: 'cc1', costCodeId: 'cc1', uncommittedCostToComplete: 100 })],
    [BLOCKER.OVER_ALLOCATED, p => p.clientReceipts.push({ id: 'cr2', receiptNumber: 'CR-0002', status: 'posted', clientId: 'c1', clientName: 'Owner Pty Ltd', receiptDate: '2026-10-20', amount: 2700, allocatedTotal: 2700, unallocatedAmount: 0, allocations: [{ clientInvoiceId: 'ci1', invoiceNumber: 'CI-0001', allocatedAmount: 2700 }] })],
  ]

  it.each(cases)('%s blocks, names itself, and yields ready: false', (code, fn) => {
    const r = compute(mutate(fn))
    expect(r.ready).toBe(false)
    expect(blockerCodes(r)).toContain(code)
    const row = readinessChecklist(r).find(c => c.code === code)
    expect(row.state).toBe('blocked')
    expect(row.fix.length).toBeGreaterThan(10)
  })

  it('an under-invoiced purchase order leaves commitment open: cost to complete is not zero', () => {
    const r = compute(mutate(p => { p.purchaseOrders[0].lineItems[0].lineTotal = 3600 }))
    expect(r.partialFigures.costToComplete).toBe(100)
    expect(r.partialFigures.finalCost).toBe(6100)
    expect(r.partialFigures.actualCost).toBe(6000)
    expect(blockerCodes(r)).toContain(BLOCKER.COST_TO_COMPLETE)
  })

  it('…and is closed out by an APPLIED negative supplier variation on that line (ADR-62) — the PO is never edited', () => {
    const r = compute(mutate(p => {
      p.purchaseOrders[0].lineItems[0].lineTotal = 3600
      p.variations.push({
        id: 'sv1', variationNumber: 'SV-0001', variationType: 'supplier', status: 'approved', poId: 'po1', approvedSubtotal: -100,
        commitmentAppliedAt: { seconds: 1 }, commitmentAppliedBy: 'u_pm',
        lineItems: [{ poLineIndex: 0, costCodeId: 'cc1', costCodeName: '03-100 — Concrete', description: 'Final account under-run', approvedAmount: -100 }],
      })
    }))
    expect(r.partialFigures.costToComplete).toBe(0)
    expect(r.partialFigures.finalCost).toBe(6000)
    expect(r.partialFigures.approvedSupplierVariations).toBe(-100)
    expect(r.blockers).toEqual([])
    expect(r.ready).toBe(true)
  })

  it('an approved claim awaiting its invoice blocks', () => {
    const r = compute(mutate(p => {
      p.purchaseOrders.push({ id: 'po2', status: 'sent', lineItems: [{ costCodeId: 'cc1', lineTotal: 40 }] })
      p.progressClaims.push({ id: 'cl2', status: 'approved', poId: 'po2', lineItems: [{ costCodeId: 'cc1', poLineIndex: 0, approvedThisPeriod: 40, claimedThisPeriod: 40 }] })
    }))
    expect(blockerCodes(r)).toContain(BLOCKER.CLAIMS_AWAITING)
  })

  // ── Over-allocated client invoices (production finding, 20 November 2026) ──
  const receipt = (id, invoiceId, amount, status = 'posted') => ({
    id, receiptNumber: id, status, clientId: 'c1', clientName: 'Owner Pty Ltd', receiptDate: '2026-10-20',
    amount, allocatedTotal: amount, unallocatedAmount: 0, allocations: [{ clientInvoiceId: invoiceId, allocatedAmount: amount }],
  })

  it('an over-allocated issued invoice BLOCKS, is named, and is compared in whole cents', () => {
    // ci1 is 9,900.00 gross with 7,700.00 allocated: 2,200.00 remains.
    const exact = compute(mutate(p => p.clientReceipts.push(receipt('cr2', 'ci1', 2200))))
    expect(blockerCodes(exact)).not.toContain(BLOCKER.OVER_ALLOCATED)
    expect(exact.partialFigures.receivablesOutstanding).toBe(0)
    expect(exact.ready).toBe(true)                      // fully paid is not over-allocated

    const oneCent = compute(mutate(p => p.clientReceipts.push(receipt('cr2', 'ci1', 2200.01))))
    expect(blockerCodes(oneCent)).toEqual([BLOCKER.OVER_ALLOCATED])
    expect(oneCent.blockers[0].detail).toBe('1 over-allocated: CI-0001')
    expect(oneCent.ready).toBe(false)

    const subCent = compute(mutate(p => p.clientReceipts.push(receipt('cr2', 'ci1', 2200.004))))
    expect(blockerCodes(subCent)).not.toContain(BLOCKER.OVER_ALLOCATED)   // float noise below a cent is not an over-allocation
  })

  it('only POSTED receipts and ISSUED invoices count: a draft or void receipt, or a void invoice, does not block', () => {
    for (const status of ['draft', 'void']) {
      const r = compute(mutate(p => p.clientReceipts.push(receipt('cr2', 'ci1', 5000, status))))
      expect(blockerCodes(r), status).not.toContain(BLOCKER.OVER_ALLOCATED)
    }
    const voided = compute(mutate(p => { p.clientReceipts.push(receipt('cr2', 'ci1', 5000)); p.clientInvoices[0].status = 'void' }))
    expect(blockerCodes(voided)).not.toContain(BLOCKER.OVER_ALLOCATED)
  })

  it('ORDINARY outstanding balances stay non-blocking: an unpaid or part-paid invoice and unallocated cash do not block', () => {
    const r = compute(mutate(p => {
      p.clientInvoices.push({ id: 'ci2', invoiceNumber: 'CI-0002', status: 'issued', clientId: 'c1', subtotal: 1000, gstTotal: 100, grossTotal: 1100, lineItems: [] })
      p.clientReceipts.push({ ...receipt('cr2', 'ci2', 100), amount: 600, unallocatedAmount: 500 })
    }))
    expect(blockerCodes(r)).not.toContain(BLOCKER.OVER_ALLOCATED)
    expect(r.partialFigures.receivablesOutstanding).toBe(2200 + 1000)
    expect(r.partialFigures.unallocatedReceipts).toBe(500)
  })

  it('the production case (Gold Coast apartments, 20 November 2026): six issued invoices, CI-0012 over-allocated by 500.00', () => {
    const invoice = (n, subtotal) => ({ id: `ci${n}`, invoiceNumber: `CI-${n}`, status: 'issued', clientId: 'c1', subtotal, gstTotal: subtotal / 10, grossTotal: subtotal * 1.1, lineItems: [] })
    const r = compute(mutate(p => {
      p.clientInvoices = [invoice('0001', 150000), invoice('0012', 20000), invoice('0013', 11000), invoice('0014', 50000), invoice('0015', 25000), invoice('0016', 50000)]
      p.clientReceipts = [receipt('r1', 'ci0001', 165000), receipt('r2', 'ci0012', 22500), receipt('r3', 'ci0013', 11000), receipt('r4', 'ci0014', 20000), receipt('r5', 'ci0015', 27500),
        { ...receipt('r6', 'none', 1000), allocatedTotal: 0, unallocatedAmount: 1000, allocations: [] }]
    }))
    const f = r.partialFigures
    expect([f.invoicedToClientGross, f.receivedAgainstInvoices, f.receivablesOutstanding, f.unallocatedReceipts, f.cashReceived]).toEqual([336600, 246000, 91100, 1000, 247000])
    // Outstanding is the sum of POSITIVE balances; the −500.00 on CI-0012 is not netted, and it blocks.
    expect(f.invoicedToClientGross - f.receivedAgainstInvoices).toBe(90600)
    expect(r.blockers.find(b => b.code === BLOCKER.OVER_ALLOCATED).detail).toBe('1 over-allocated: CI-0012')
  })

  it('more than five over-allocated invoices are counted in full and listed in part', () => {
    const r = compute(mutate(p => {
      for (let i = 2; i <= 8; i += 1) {
        p.clientInvoices.push({ id: `ci${i}`, invoiceNumber: `CI-000${i}`, status: 'issued', clientId: 'c1', subtotal: 100, gstTotal: 10, grossTotal: 110, lineItems: [] })
        p.clientReceipts.push(receipt(`cr${i}`, `ci${i}`, 120))
      }
    }))
    expect(r.blockers.find(b => b.code === BLOCKER.OVER_ALLOCATED).detail).toMatch(/^7 over-allocated: .*, …$/)
  })

  it('a FAILED source blocks on SOURCES alone, names the source and never yields a figure set', () => {
    const r = compute(readyProject(), { ...settledSourceStates(), supplierInvoices: { loading: false, error: true } })
    expect(r.ready).toBe(false)
    expect(blockerCodes(r)).toEqual([BLOCKER.SOURCES])
    expect(r.blockers[0].detail).toContain('Supplier Invoices')
    expect(r.figures).toBeNull()
    expect(r.partialFigures.actualCost).toBeNull()   // Unavailable — never a zero
  })

  it('a LOADING source is not ready and not zero; a missing state entry is a failure', () => {
    const loading = compute(readyProject(), { ...settledSourceStates(), clientReceipts: { loading: true, error: false } })
    expect(loading.loading).toBe(true)
    expect(loading.ready).toBe(false)
    expect(loading.figures).toBeNull()
    expect(readinessChecklist(loading).every(c => c.state === 'pending')).toBe(true)
    expect(compute(readyProject(), without(settledSourceStates(), 'variations')).ready).toBe(false)
  })

  it('cost codes still loading (names) hold a client back; the server passes no such entry', () => {
    const r = compute(readyProject(), { ...settledSourceStates(), costCodes: { loading: true, error: false } })
    expect(r.ready).toBe(false)
    expect(compute(readyProject(), { ...settledSourceStates(), costCodes: { loading: false, error: true } }).blockers[0].detail).toContain('Cost Codes')
  })

  it('a working (unapproved) budget is never accepted and its figure is not carried', () => {
    const r = compute(mutate(p => { p.pointer = null }))
    expect(r.partialFigures.approvedBudget).toBeNull()
    expect(r.partialFigures.varianceToBudget).toBeNull()
    expect(r.figures).toBeNull()
  })

  it('an approved budget that fails its integrity check is unavailable, never the working lines', () => {
    const r = compute(mutate(p => { p.budgetApprovalSnapshots[0].total = 6999 }))
    expect(blockerCodes(r)).toContain(BLOCKER.BUDGET)
    expect(r.blockers.find(b => b.code === BLOCKER.BUDGET).detail).toBe('Approved budget unavailable')
    expect(r.partialFigures.approvedBudget).toBeNull()
    expect(r.figures).toBeNull()
  })

  it('outstanding balances are NOT blockers — they are listed, zero included, for acknowledgement', () => {
    const c = compute()
    expect(c.ready).toBe(true)
    expect(c.openItems.map(i => i.key)).toEqual(FINAL_ACCOUNT_OPEN_KEYS)
    expect(Object.fromEntries(c.openItems.map(i => [i.key, i.value]))).toEqual({
      remainingToInvoice: 3000, receivablesOutstanding: 2200, clientRetentionHeld: 0, owedToClient: 0, unallocatedReceipts: 0,
      payablesOutstanding: 1490, unallocatedPayments: 200, retentionHeld: 110,
    })
  })

  it('a margin that cannot be calculated is null (allowed); any other missing figure blocks', () => {
    const zeroRevenue = compute(mutate(p => { p.baseline.originalContractValue = 0; p.variations = []; p.clientInvoices = []; p.clientReceipts = [] }))
    expect(zeroRevenue.partialFigures.finalMarginPct).toBeNull()
    expect(blockerCodes(zeroRevenue)).not.toContain(BLOCKER.FIGURES)
    expect(READINESS_CHECKS.map(c => c.code)).toEqual(Object.values(BLOCKER))
  })
})

// ── 2a. Forecast completeness (C1-A correction; ADR-43 Decision 2, ADR-67 Decision 6) ──
//
// "Cost to complete is zero" cannot tell a reviewed 0 from a cost code nobody
// forecast: an unforecast code contributes zero. Missing forecasts are their
// own requirement, judged on the same rows the Forecast tab lists.

describe('forecast completeness is a readiness requirement of its own', () => {
  const noLine = (id) => (p) => { p.forecastLines = p.forecastLines.filter(f => f.id !== id) }

  it('NO forecast on a budgeted cost code: not ready, the code is named, and the figures are untouched', () => {
    const r = compute(mutate(noLine('cc1')))
    expect(r.ready).toBe(false)
    expect(blockerCodes(r)).toEqual([BLOCKER.FORECAST_INCOMPLETE])
    expect(r.blockers[0].detail).toBe('1 of 2 not forecast: 03-100 — Concrete')
    expect(r.unforecastCostCodes).toEqual([{ costCodeId: 'cc1', costCodeName: '03-100 — Concrete' }])
    // The defect: cost to complete is still a clean zero — only the new requirement catches it.
    expect(r.partialFigures.costToComplete).toBe(0)
    expect(r.figures).toEqual(EXPECTED_FIGURES)
    const row = readinessChecklist(r).find(c => c.code === BLOCKER.FORECAST_INCOMPLETE)
    expect(row).toMatchObject({ state: 'blocked', label: 'Every cost code has a saved forecast' })
    expect(row.fix).toContain('Forecast tab')
    expect(row.fix).toContain('a saved 0 is a forecast')
    expect(readinessChecklist(r).find(c => c.code === BLOCKER.COST_TO_COMPLETE).state).toBe('ok')
  })

  it('NO forecast line at all (the production reproduction): every budgeted code is named', () => {
    const r = compute(mutate(p => { p.forecastLines = [] }))
    expect(r.ready).toBe(false)
    expect(blockerCodes(r)).toEqual([BLOCKER.FORECAST_INCOMPLETE])
    expect(r.blockers[0].detail).toBe('2 of 2 not forecast: 03-100 — Concrete, 03-200 — Formwork')
  })

  it('an EXPLICIT forecast of 0 on every code is complete: ready, with the expected figures', () => {
    const r = compute()
    expect(r.blockers).toEqual([])
    expect(r.ready).toBe(true)
    expect(r.unforecastCostCodes).toEqual([])
    expect(r.figures).toEqual(EXPECTED_FIGURES)
  })

  it('a line that exists but holds a blank (null) input is NOT a forecast', () => {
    for (const blank of [null, undefined]) {
      const r = compute(mutate(p => { p.forecastLines[1].uncommittedCostToComplete = blank }))
      expect(blockerCodes(r)).toEqual([BLOCKER.FORECAST_INCOMPLETE])
      expect(r.blockers[0].detail).toBe('1 of 2 not forecast: 03-200 — Formwork')
    }
  })

  it('a POSITIVE cost to complete is forecast — it fails "cost to complete is zero", not completeness', () => {
    const r = compute(mutate(p => { p.forecastLines[0].uncommittedCostToComplete = 100 }))
    expect(blockerCodes(r)).toEqual([BLOCKER.COST_TO_COMPLETE])
    expect(r.unforecastCostCodes).toEqual([])
    expect(r.partialFigures.costToComplete).toBe(100)
  })

  it('MIXED coverage: a zero, a positive and two missing codes — both requirements fail and only the missing are named', () => {
    const r = compute(mutate(p => {
      p.costCodes.push({ id: 'cc3', code: '04-100', name: 'Masonry', isActive: true }, { id: 'cc4', code: '05-100', name: 'Steel', isActive: true })
      p.forecastLines[0].uncommittedCostToComplete = 0          // cc1 — reviewed, nothing left
      p.forecastLines[1].uncommittedCostToComplete = 250        // cc2 — cost still to come
      // cc3 — cost incurred, never forecast (an unbudgeted code is in the union too)
      p.supplierInvoices.push({ ...p.supplierInvoices[0], id: 'inv3', invoiceNumber: 'SI-0003', poId: null, source: 'direct_po',
        lineItems: [{ costCodeId: 'cc3', costCodeName: '04-100 — Masonry', amount: 40, taxCode: 'gst', gstAmount: 4 }],
        retention: 0, retentionGst: 0, retentionTotal: 0, subtotal: 40, gstTotal: 4, grossTotal: 44, net: 40, payableGst: 4, payableTotal: 44 })
      // cc4 — a forecast line saved with a blank input
      p.forecastLines.push({ id: 'cc4', costCodeId: 'cc4', costCodeName: '05-100 — Steel', uncommittedCostToComplete: null })
    }))
    expect(blockerCodes(r)).toEqual([BLOCKER.FORECAST_INCOMPLETE, BLOCKER.COST_TO_COMPLETE])
    expect(r.unforecastCostCodes.map(c => c.costCodeId)).toEqual(['cc3', 'cc4'])
    expect(r.blockers[0].detail).toBe('2 of 4 not forecast: 04-100 — Masonry, 05-100 — Steel')
  })

  it('more than five missing codes: five are named, the count is exact', () => {
    const r = compute(mutate(p => {
      p.forecastLines = []
      for (let i = 3; i <= 8; i += 1) p.forecastLines.push({ id: `cc${i}`, costCodeId: `cc${i}`, costCodeName: `Z${i}`, uncommittedCostToComplete: null })
    }))
    expect(r.blockers[0].detail).toMatch(/^8 of 8 not forecast: /)
    expect(r.blockers[0].detail.endsWith(', …')).toBe(true)
    expect(r.blockers[0].detail.split(', ')).toHaveLength(6)
  })

  it('unreadable or loading sources never report a forecast as missing — they report the source', () => {
    const states = settledSourceStates()
    const failed = compute(mutate(p => { p.forecastLines = [] }), { ...states, forecastLines: { loading: false, error: true } })
    expect(blockerCodes(failed)).toEqual([BLOCKER.SOURCES])
    expect(failed.unforecastCostCodes).toEqual([])
    const loading = compute(mutate(p => { p.forecastLines = [] }), { ...states, forecastLines: { loading: true, error: false } })
    expect(blockerCodes(loading)).toEqual([BLOCKER.SOURCES])
  })

  it('a forecast that goes missing AFTER the draft: the figures still agree, so only readiness stops the approval', () => {
    const c = compute()
    const built = buildFinalAccountDraft({ computation: c, number: 1, input: { reason: 'Works complete', reference: '', acknowledged: true }, currencyCode: 'AUD', preparedByName: 'Quin QS' })
    expect(built.ok).toBe(true)
    const draft = { ...built.payload, status: 'draft', revision: 1 }
    const later = compute(mutate(p => { p.forecastLines[0].uncommittedCostToComplete = null }))
    expect(draftAgreesWith(draft, later)).toBe(true)                 // no figure moved …
    expect(finalAccountDifferences(draft, later).changed).toBe(false)
    expect(later.ready).toBe(false)                                  // … so the readiness gate is the guard
    expect(blockerCodes(later)).toEqual([BLOCKER.FORECAST_INCOMPLETE])
  })

  it('a draft cannot be built from records with a missing forecast', () => {
    const built = buildFinalAccountDraft({ computation: compute(mutate(p => { p.forecastLines = [] })), number: 1,
      input: { reason: 'Works complete', reference: '', acknowledged: true }, currencyCode: 'AUD', preparedByName: 'Quin QS' })
    expect(built.ok).toBe(false)
  })

  it('an APPROVED revision is untouched: it is compared, never re-gated, and its stored content does not change', () => {
    const approved = stored()
    const before = JSON.stringify(approved)
    const later = compute(mutate(p => { p.forecastLines = [] }))
    const diff = finalAccountDifferences(approved, later)
    expect(diff.comparable).toBe(true)
    expect(diff.changed).toBe(false)
    expect(JSON.stringify(approved)).toBe(before)
    expect(finalAccountHistory([approved]).current.number).toBe(1)
  })

  it('the page and the checklist carry no separate copy of the rule', () => {
    const lib = stripComments(read('src/lib/finalAccount.js'))
    expect(lib).toContain("import { projectForecastRows } from './margin'")
    expect(lib).toMatch(/forecastRows\.filter\(r => r\.unforecasted\)/)
    const page = stripComments(read('src/pages/project/ProjectFinalAccount.jsx'))
    expect(page).not.toMatch(/unforecasted|uncommittedCostToComplete/)
  })
})

// ── 2c. The receivable contract (ADR-87 / ADR-88) ────────────────────────────
//
// The fixture: contract 12,000; CI-0001 9,000 ex-GST / 9,900 gross; 7,700
// received. Every case replaces CI-0001 with the same invoice carrying its line
// (a credit note credits a LINE) and, where stated, client retention.

describe('client credit notes and client retention follow the ONE receivable contract', () => {
  const withInvoice = (retention, fn) => mutate(p => { p.clientInvoices[0] = issuedInvoice({ retention }); fn(p, p.clientInvoices[0]) })

  it('an invoice carrying its line and no credit or retention changes no figure', () => {
    const r = compute(withInvoice(0, () => {}))
    expect(r.ready).toBe(true)
    expect(r.figures).toEqual(EXPECTED_FIGURES)
  })

  it('a posted credit note reduces NET invoiced and re-opens the same amount to invoice — never the contract sum, cost, margin or cash', () => {
    const r = compute(withInvoice(0, (p, inv) => p.clientCreditNotes.push(creditNoteFor(inv, 1000))))
    expect(r.ready).toBe(true)
    expect(r.figures).toEqual({
      ...EXPECTED_FIGURES,
      invoicedToClient: 8000, creditedToClient: 1000, remainingToInvoice: 4000,   // ex-GST
      invoicedToClientGross: 8800, receivablesOutstanding: 1100,                  // gross: 9,900 − 1,100 − 7,700
    })
    // Unchanged, stated: a credit is an invoice correction, not a contract adjustment and not cash.
    for (const key of ['finalContractSum', 'approvedClientVariations', 'actualCost', 'finalCost', 'finalProfit', 'finalMarginPct', 'cashReceived', 'receivedAgainstInvoices']) {
      expect(r.figures[key], key).toBe(EXPECTED_FIGURES[key])
    }
    expect(r.provenance.counts).toMatchObject({ clientCreditNotes: 1, clientRetentionReleases: 0 })
  })

  it('the figures ARE the contract\'s: contractControl over its totals, receivablesSummary over its positions', () => {
    const p = withInvoice(500, (x, inv) => { x.clientCreditNotes.push(creditNoteFor(inv, 1000)); x.clientRetentionReleases.push(releaseFor(inv, 200)) })
    const r = compute(p)
    const context = receivableContext(p.clientInvoices, p.clientCreditNotes, p.clientRetentionReleases)
    const control = contractControl(p.clientInvoices, 12000, context.totals)
    const summary = receivablesSummary(p.clientInvoices, p.clientReceipts, context.positions)
    expect(r.partialFigures.invoicedToClient).toBe(control.issued.subtotal)
    expect(r.partialFigures.creditedToClient).toBe(control.credited.subtotal)
    expect(r.partialFigures.invoicedToClientGross).toBe(control.issued.grossTotal)
    expect(r.partialFigures.remainingToInvoice).toBe(control.availableToInvoice)
    expect(r.partialFigures.receivedAgainstInvoices).toBe(summary.received)
    expect(r.partialFigures.receivablesOutstanding).toBe(summary.remaining)
    expect(r.partialFigures.clientRetentionHeld).toBe(summary.retentionHeld)
    expect(r.partialFigures.owedToClient).toBe(summary.owedToClient)
    // The module holds no receivable arithmetic of its own.
    const src = stripComments(read('src/lib/finalAccount.js'))
    expect(src).toContain('receivableContext(clientInvoices, clientCreditNotes, clientRetentionReleases)')
    expect(src).toContain('contractControl(clientInvoices, finalContractSum, receivable.totals)')
    expect(src).toContain('receivablesSummary(clientInvoices, clientReceipts, receivable.positions)')
  })

  it('client retention withheld is BILLED but not receivable: invoiced is unchanged, outstanding excludes it, and it is held', () => {
    const r = compute(withInvoice(500, () => {}))        // 500 ex-GST + 50 GST withheld
    expect(r.ready).toBe(true)
    expect(r.figures).toEqual({ ...EXPECTED_FIGURES, receivablesOutstanding: 1650, clientRetentionHeld: 550 })
    expect(r.figures.invoicedToClient).toBe(9000)        // retention is not a reduction in what was billed
    expect(r.openItems.find(i => i.key === 'clientRetentionHeld')).toMatchObject({ value: 550, basis: FIGURE_BASIS.GROSS })
  })

  it('a posted release moves retention from held to receivable — and moves no cash', () => {
    const r = compute(withInvoice(500, (p, inv) => p.clientRetentionReleases.push(releaseFor(inv, 200))))
    expect(r.figures).toEqual({ ...EXPECTED_FIGURES, receivablesOutstanding: 1870, clientRetentionHeld: 330 })
    expect(r.figures.cashReceived).toBe(7700)
    // A draft or void release releases nothing.
    for (const status of ['draft', 'void']) {
      const other = compute(withInvoice(500, (p, inv) => p.clientRetentionReleases.push(releaseFor(inv, 200, { status }))))
      expect(other.partialFigures.clientRetentionHeld, status).toBe(550)
    }
  })

  it('a credit AFTER receipt leaves an amount OWED TO THE CLIENT: shown, never clamped to zero, never netted against another invoice', () => {
    const r = compute(withInvoice(0, (p, inv) => {
      p.clientCreditNotes.push(creditNoteFor(inv, 2500))                  // 2,750 gross: 9,900 − 2,750 = 7,150 receivable, 7,700 received
      p.clientInvoices.push(issuedInvoice({ id: 'ci2', invoiceNumber: 'CI-0002', subtotal: 1000 }))   // 1,100 owing, untouched
    }))
    expect(r.partialFigures.owedToClient).toBe(550)
    expect(r.partialFigures.receivablesOutstanding).toBe(1100)           // NOT 1,100 − 550
    expect(r.partialFigures.receivedAgainstInvoices).toBe(7700)          // the cash stays the cash
    expect(r.partialFigures.creditedToClient).toBe(2500)
  })

  it('OVER-ALLOCATED is measured against what is RECEIVABLE, not the gross: a credit or held retention can make a paid invoice over-allocated', () => {
    // 9,900 gross, 7,700 received: not over-allocated on gross — but only 7,150 is receivable after the credit.
    const credited = compute(withInvoice(0, (p, inv) => p.clientCreditNotes.push(creditNoteFor(inv, 2500))))
    expect(blockerCodes(credited)).toEqual([BLOCKER.OVER_ALLOCATED])
    expect(credited.blockers[0].detail).toBe('1 over-allocated: CI-0001')
    // 9,900 gross with 2,500 + 250 retention held: 7,150 receivable, 7,700 received.
    const retained = compute(withInvoice(2500, () => {}))
    expect(blockerCodes(retained)).toEqual([BLOCKER.OVER_ALLOCATED])
    expect(retained.partialFigures.owedToClient).toBe(550)
    // Exactly paid to the receivable basis is NOT over-allocated (whole cents).
    const exact = compute(withInvoice(2000, () => {}))                   // 9,900 − 2,200 = 7,700
    expect(blockerCodes(exact)).toEqual([])
    expect(exact.figures).toMatchObject({ receivablesOutstanding: 0, owedToClient: 0, clientRetentionHeld: 2200 })
  })

  it('a posted credit note that FAILS the validity gate reduces nothing and blocks by name', () => {
    const r = compute(withInvoice(0, (p, inv) => p.clientCreditNotes.push(creditNoteFor(inv, 1000, { clientId: 'someone-else' }))))
    expect(blockerCodes(r)).toEqual([BLOCKER.CLIENT_CREDIT_EXCEPTIONS])
    expect(r.blockers[0].detail).toBe('1 failing: CCN-0001')
    expect(r.partialFigures.invoicedToClient).toBe(9000)                 // the debt stays visible
    expect(r.partialFigures.creditedToClient).toBe(0)
    expect(r.partialFigures.receivablesOutstanding).toBe(2200)
  })

  it('a posted release that names no releasable invoice releases nothing and blocks by name', () => {
    const r = compute(withInvoice(0, (p) => p.clientRetentionReleases.push({ id: 'x', releaseNumber: 'CRR-0007', status: 'posted', clientInvoiceId: 'ci1', amount: 10, gstAmount: 1, releaseTotal: 11 })))
    expect(blockerCodes(r)).toEqual([BLOCKER.CLIENT_RELEASE_EXCEPTIONS])
    expect(r.blockers[0].detail).toBe('1 failing: CRR-0007')
    expect(r.partialFigures.receivablesOutstanding).toBe(2200)
  })

  it('a VOID credit note or release counts nothing and blocks nothing', () => {
    const r = compute(withInvoice(500, (p, inv) => {
      p.clientCreditNotes.push(creditNoteFor(inv, 1000, { status: 'void' }))
      p.clientRetentionReleases.push(releaseFor(inv, 200, { status: 'void' }))
    }))
    expect(r.ready).toBe(true)
    expect(r.figures).toEqual({ ...EXPECTED_FIGURES, receivablesOutstanding: 1650, clientRetentionHeld: 550 })
  })

  it('a FAILED credit-note read is UNKNOWN: every figure that depends on it is unavailable — not the figure "no credits" would give', () => {
    const p = withInvoice(0, (x, inv) => x.clientCreditNotes.push(creditNoteFor(inv, 1000)))
    // What a failed listener hands the page: an empty register and error: true.
    p.clientCreditNotes = []
    const r = compute(p, { ...settledSourceStates(), clientCreditNotes: { loading: false, error: true } })
    expect(r.ready).toBe(false)
    expect(blockerCodes(r)).toEqual([BLOCKER.SOURCES])
    expect(r.blockers[0].detail).toContain('Client Credit Notes')
    expect(r.figures).toBeNull()
    for (const key of ['invoicedToClient', 'creditedToClient', 'remainingToInvoice', 'invoicedToClientGross', 'receivablesOutstanding', 'clientRetentionHeld', 'owedToClient']) {
      expect(r.partialFigures[key], key).toBeNull()
    }
    // Figures that do not read credit notes are still shown.
    expect(r.partialFigures.finalContractSum).toBe(12000)
    expect(r.partialFigures.cashReceived).toBe(7700)
    expect(r.partialFigures.receivedAgainstInvoices).toBe(7700)
    expect(finalAccountDifferences(stored(), r).comparable).toBe(false)
  })

  it('a FAILED retention-release read makes outstanding, held and owed unavailable; invoiced does not read releases', () => {
    const r = compute(withInvoice(500, () => {}), { ...settledSourceStates(), clientRetentionReleases: { loading: false, error: true } })
    expect(blockerCodes(r)).toEqual([BLOCKER.SOURCES])
    expect(r.blockers[0].detail).toContain('Client Retention Releases')
    for (const key of ['receivablesOutstanding', 'clientRetentionHeld', 'owedToClient']) expect(r.partialFigures[key], key).toBeNull()
    expect(r.partialFigures.invoicedToClient).toBe(9000)
    expect(r.partialFigures.remainingToInvoice).toBe(3000)
  })

  it('a LOADING register is not ready and not zero; a missing state entry is a failure', () => {
    const loading = compute(readyProject(), { ...settledSourceStates(), clientCreditNotes: { loading: true, error: false } })
    expect(loading.loading).toBe(true)
    expect(loading.figures).toBeNull()
    expect(loading.partialFigures.invoicedToClient).toBeNull()
    expect(compute(readyProject(), without(settledSourceStates(), 'clientRetentionReleases')).ready).toBe(false)
  })

  it('no figure adds an ex-GST amount to a gross one: the three new figures are basis-labelled like the rest', () => {
    const def = (key) => FINAL_ACCOUNT_FIGURES.find(f => f.key === key)
    expect(def('creditedToClient')).toMatchObject({ basis: FIGURE_BASIS.EX_GST, group: 'contract' })
    expect(def('creditedToClient').note).toContain('Posted client credit notes')
    expect(def('creditedToClient').open).toBeUndefined()
    expect(def('clientRetentionHeld')).toMatchObject({ basis: FIGURE_BASIS.GROSS, group: 'balances', open: true, note: 'Billed and withheld by the client — not receivable until released' })
    expect(def('owedToClient')).toMatchObject({ basis: FIGURE_BASIS.GROSS, group: 'balances', open: true, note: 'Received beyond what is now receivable — a client credit balance' })
  })

  it('the larger record still fits the Rules bounds on a draft (figures ≤ 40 keys, sources ≤ 10 keys)', () => {
    const rules = read('firestore.rules')
    const limit = (re) => Number(rules.match(re)[1])
    const content = finalAccountContent(compute())
    expect(FINAL_ACCOUNT_FIGURE_KEYS).toHaveLength(25)
    expect(Object.keys(content.figures)).toHaveLength(25)
    expect(Object.keys(content.figures).length).toBeLessThanOrEqual(limit(/d\.figures is map && d\.figures\.size\(\) <= (\d+)/))
    // `sources` holds five keys; the register counts are ONE nested map.
    expect(Object.keys(content.sources).sort()).toEqual(['adjustmentCount', 'budgetApprovalId', 'budgetCaption', 'budgetVersion', 'counts'])
    expect(Object.keys(content.sources).length).toBeLessThanOrEqual(limit(/d\.sources is map && d\.sources\.size\(\) <= (\d+)/))
    expect(Object.keys(content.sources.counts)).toHaveLength(12)
  })
})

// ── 2d. The hand-mirrored source lists ───────────────────────────────────────

describe('the two receivable registers are in every source list — and the ledger is in none', () => {
  const NEW = ['clientCreditNotes', 'clientRetentionReleases']
  const between = (src, from, to) => src.slice(src.indexOf(from), src.indexOf(to, src.indexOf(from)))

  it('the report sources, the counted sources, the server-read names, the hook queries and the callable agree', () => {
    for (const name of NEW) {
      expect(Object.keys(settledSourceStates()), name).toContain(name)                       // REPORT_SOURCES
      expect(Object.keys(compute().provenance.counts), name).toContain(name)                 // FINAL_ACCOUNT_COUNTED_SOURCES
      expect(FINAL_ACCOUNT_QUERY_NAMES, name).toContain(name)
      expect(between(read('src/hooks/useFinalAccounts.jsx'), 'queries: {', 'refs: {'), name).toContain(`${name}: ordered('${name}')`)
      expect(between(read('functions/src/finalAccount/approve.js'), 'const ORDERED = [', ']'), name).toContain(`'${name}'`)
    }
  })

  it('every list names the same project registers (cost codes and the unordered forecast lines apart)', () => {
    const ordered = between(read('functions/src/finalAccount/approve.js'), 'const ORDERED = [', ']').match(/'(\w+)'/g).map(s => s.slice(1, -1))
    const queries = FINAL_ACCOUNT_QUERY_NAMES.filter(n => n !== 'costCodes' && n !== 'forecastLines')
    expect([...ordered].sort()).toEqual([...queries].sort())
    const counted = Object.keys(compute().provenance.counts)
    expect([...counted, 'budgetLines'].sort()).toEqual([...FINAL_ACCOUNT_QUERY_NAMES.filter(n => n !== 'costCodes')].sort())
  })

  it('the per-invoice ledger is an enforcement device, never a Final Account source', () => {
    for (const f of ['src/lib/finalAccount.js', 'src/lib/finalAccountActions.js', 'src/hooks/useFinalAccounts.jsx', 'functions/src/finalAccount/approve.js', 'src/lib/commercialReport.js', 'src/lib/portfolioSources.js']) {
      expect(stripComments(read(f)), f).not.toMatch(/clientInvoiceLedgers|useClientInvoiceLedgers/)
    }
  })
})

// ── 3. Draft payload and size ────────────────────────────────────────────────

describe('the draft payload', () => {
  const input = { reason: '  Works complete  ', reference: 'FA-1', acknowledged: true }

  it('carries the computed content, the acknowledgement and no lifecycle or amount of its own', () => {
    const c = compute()
    const b = buildFinalAccountDraft({ computation: c, number: 1, input, currencyCode: 'AUD', preparedByName: 'Quin QS' })
    expect(b.ok).toBe(true)
    expect(b.payload).toMatchObject({ number: 1, reason: 'Works complete', reference: 'FA-1', currency: 'AUD', rowCount: 2, openItemsAcknowledged: true, preparedByName: 'Quin QS' })
    expect(b.payload.figures).toEqual(EXPECTED_FIGURES)
    expect(b.payload.sources.budgetApprovalId).toBe('ba1')
    expect(b.payload).not.toHaveProperty('status')
  })

  it('refuses a computation that is not ready, a missing basis and a missing acknowledgement', () => {
    const notReady = compute(mutate(p => { p.baseline = null }))
    expect(buildFinalAccountDraft({ computation: notReady, number: 1, input, currencyCode: 'AUD' }).ok).toBe(false)
    expect(validateFinalAccountInput({ reason: ' ', acknowledged: true })).toMatch(/basis/)
    expect(validateFinalAccountInput({ reason: 'x', acknowledged: false })).toMatch(/Acknowledge/)
    expect(validateFinalAccountInput({ reason: 'x'.repeat(501), acknowledged: true })).toMatch(/500/)
    expect(validateFinalAccountWithdrawReason('  ')).toMatch(/reason/)
    expect(buildFinalAccountDraft({ computation: compute(), number: 0, input, currencyCode: 'AUD' }).ok).toBe(false)
  })

  it('1,000 cost-code rows with 170-character names stay well inside one Firestore document', () => {
    const c = compute()
    const rows = Array.from({ length: FINAL_ACCOUNT_LIMITS.ROWS }, (_, i) => ({
      costCodeId: `cc${String(i).padStart(18, '0')}`, costCodeName: 'N'.repeat(170), approvedBudget: 1234567.89, actualCost: 1234567.89, variance: 0,
    }))
    const payload = { number: 1, reason: 'r'.repeat(500), reference: 'x'.repeat(200), currency: 'AUD', ...finalAccountContent({ ...c, rows }) }
    const bytes = estimateFinalAccountBytes(payload)
    expect(bytes).toBeLessThan(FINAL_ACCOUNT_MAX_BYTES)
    expect(bytes).toBeGreaterThan(200000)            // the estimate is not trivially small
    expect(FINAL_ACCOUNT_MAX_BYTES).toBeLessThan(1048576)
  })

  it('more cost codes than one record holds is a named blocker, never a truncation', () => {
    const p = readyProject()
    const entries = Array.from({ length: 1001 }, (_, i) => ({ lineId: `l${i}`, costCodeId: `c${i}`, costCodeName: `Code ${i}`, budgeted: 1 }))
    p.budgetApprovalSnapshots[0] = { id: 'ba1', entryCount: 1001, total: 1001, currency: 'AUD', entries }
    p.budgetApprovals[0] = { ...p.budgetApprovals[0], entryCount: 1001, total: 1001 }
    const r = compute(p)
    expect(r.rows.length).toBeGreaterThan(FINAL_ACCOUNT_LIMITS.ROWS)
    expect(blockerCodes(r)).toContain(BLOCKER.SIZE)
  })
})

// ── 4. Snapshot immutability and drift ───────────────────────────────────────

describe('an approved revision is compared with live records, never recalculated', () => {
  it('identical records → no difference', () => {
    const d = finalAccountDifferences(stored(), compute())
    expect(d).toMatchObject({ comparable: true, changed: false, figures: [], rows: [], provenance: [] })
    expect(draftAgreesWith(stored({ status: 'draft' }), compute())).toBe(true)
  })

  it('a later posted invoice is reported as drift; the stored figures are untouched', () => {
    const s = stored()
    const before = JSON.stringify(s)
    const live = compute(mutate(p => {
      p.purchaseOrders.push({ id: 'po2', status: 'sent', lineItems: [{ costCodeId: 'cc1', lineTotal: 250 }] })
      p.supplierInvoices.push({ ...p.supplierInvoices[0], id: 'inv2', poId: 'po2', retention: 0, retentionGst: 0, retentionTotal: 0,
        lineItems: [{ poLineIndex: 0, costCodeId: 'cc1', costCodeName: '03-100 — Concrete', amount: 250, taxCode: 'gst', gstAmount: 25 }],
        subtotal: 250, gstTotal: 25, grossTotal: 275, net: 250, payableGst: 25, payableTotal: 275 })
    }))
    const d = finalAccountDifferences(s, live)
    expect(d.changed).toBe(true)
    expect(d.figures.find(f => f.key === 'actualCost')).toMatchObject({ stored: 6000, live: 6250 })
    expect(d.figures.map(f => f.key)).toEqual(expect.arrayContaining(['finalCost', 'finalProfit', 'varianceToBudget', 'payablesOutstanding']))
    expect(d.rows.map(r => r.costCodeId)).toEqual(['cc1'])
    expect(d.provenance).toEqual(expect.arrayContaining(['purchaseOrders', 'supplierInvoices']))
    expect(JSON.stringify(s)).toBe(before)
    expect(draftAgreesWith({ ...s, status: 'draft' }, live)).toBe(false)
  })

  it('an edited contract value is drift on the contract figures', () => {
    const d = finalAccountDifferences(stored(), compute(mutate(p => { p.baseline.originalContractValue = 10500 })))
    expect(d.figures.map(f => f.key)).toEqual(expect.arrayContaining(['originalContractValue', 'finalContractSum', 'remainingToInvoice', 'finalProfit']))
  })

  it('a re-approved budget version is a provenance difference even when the totals agree', () => {
    const live = compute(mutate(p => {
      p.pointer = { activeApprovalId: 'ba2', originalApprovalId: 'ba1', versionCount: 2 }
      p.budgetApprovals.push({ ...p.budgetApprovals[0], id: 'ba2', version: 2 })
      p.budgetApprovalSnapshots.push({ ...p.budgetApprovalSnapshots[0], id: 'ba2' })
    }))
    const d = finalAccountDifferences(stored(), live)
    expect(d.changed).toBe(false)
    expect(d.provenance).toContain('budget')
    expect(draftAgreesWith(stored({ status: 'draft' }), live)).toBe(false)
  })

  it('cent-level agreement only: a sub-cent float difference is not drift, one cent is', () => {
    const s = stored()
    s.figures = { ...s.figures, actualCost: 6000.004 }
    expect(finalAccountDifferences(s, compute()).changed).toBe(false)
    s.figures = { ...s.figures, actualCost: 6000.01 }
    expect(finalAccountDifferences(s, compute()).figures.map(f => f.key)).toEqual(['actualCost'])
  })

  it('live records that cannot be read are NOT comparable — never reported as "no change"', () => {
    const d = finalAccountDifferences(stored(), compute(readyProject(), { ...settledSourceStates(), variations: { loading: false, error: true } }))
    expect(d.comparable).toBe(false)
  })

  it('a draft whose rows were reordered or dropped does not agree', () => {
    const s = stored({ status: 'draft' })
    expect(draftAgreesWith({ ...s, rows: [s.rows[1], s.rows[0]] }, compute())).toBe(false)
    expect(draftAgreesWith({ ...s, rows: [s.rows[0]] }, compute())).toBe(false)
    expect(draftAgreesWith({ ...s, figures: { ...s.figures, finalProfit: 999999 } }, compute())).toBe(false)
  })
})

// ── 4b. Version-aware comparison (Commercial Finance Phase 1) ────────────────
//
// A revision approved BEFORE `creditedToClient`, `clientRetentionHeld` and
// `owedToClient` existed carries 22 figure keys and 10 register counts. It is
// never rewritten. It must show no drift merely because the app now computes
// more — and must still show a real movement in a figure it does carry.

describe('a revision is compared on its OWN schema', () => {
  const NEW_FIGURES = ['creditedToClient', 'clientRetentionHeld', 'owedToClient']
  const NEW_SOURCES = ['clientCreditNotes', 'clientRetentionReleases']
  const strip = (obj, keys) => Object.fromEntries(Object.entries(obj).filter(([k]) => !keys.includes(k)))
  const legacy = (over = {}) => {
    const s = stored(over)
    return { ...s, figures: strip(s.figures, NEW_FIGURES), sources: { ...s.sources, counts: strip(s.sources.counts, NEW_SOURCES) } }
  }
  const credited = () => compute(mutate(p => { p.clientInvoices[0] = issuedInvoice(); p.clientCreditNotes.push(creditNoteFor(p.clientInvoices[0], 1000)) }))

  it('the legacy fixture really is the old schema', () => {
    const s = legacy()
    expect(Object.keys(s.figures)).toHaveLength(22)
    expect(Object.keys(s.sources.counts)).toHaveLength(10)
    for (const k of NEW_FIGURES) expect(k in s.figures, k).toBe(false)
  })

  it('an old-schema approved revision against unchanged records: NO change, NO provenance difference — the new metrics are listed apart', () => {
    const d = finalAccountDifferences(legacy(), compute())
    expect(d).toMatchObject({ comparable: true, changed: false, figures: [], rows: [], provenance: [] })
    expect(d.newMetrics.map(n => n.key)).toEqual(NEW_FIGURES)
    expect(d.newMetrics[0]).toEqual({ key: 'creditedToClient', label: 'Credited to client', basis: FIGURE_BASIS.EX_GST, live: 0 })
    expect(d.newSources).toEqual(NEW_SOURCES)
  })

  it('…even when the live records now HOLD client retention: a metric the revision never recorded is not a change', () => {
    // The live value of a new metric is non-zero; only keys the revision carries are compared.
    const live = compute(mutate(p => { p.clientInvoices[0] = issuedInvoice({ retention: 500 }) }))
    const d = finalAccountDifferences(legacy(), live)
    expect(d.newMetrics.find(n => n.key === 'clientRetentionHeld').live).toBe(550)
    expect(d.figures.map(f => f.key)).toEqual(['receivablesOutstanding'])   // a key it DOES carry moved: 2,200 → 1,650
    expect(d.figures.map(f => f.key)).not.toContain('clientRetentionHeld')
  })

  it('an old-schema approved revision + a credit note posted later: the movement is reported — on the old keys only', () => {
    const d = finalAccountDifferences(legacy(), credited())
    expect(d.changed).toBe(true)
    expect(d.figures.map(f => f.key)).toEqual(['invoicedToClient', 'remainingToInvoice', 'invoicedToClientGross', 'receivablesOutstanding'])
    expect(d.figures.find(f => f.key === 'invoicedToClient')).toMatchObject({ stored: 9000, live: 8000 })
    expect(d.figures.find(f => f.key === 'receivablesOutstanding')).toMatchObject({ stored: 2200, live: 1100 })
    for (const k of NEW_FIGURES) expect(d.figures.map(f => f.key), k).not.toContain(k)
    expect(d.newMetrics.find(n => n.key === 'creditedToClient').live).toBe(1000)
    // The register did not exist in the revision's provenance, so its count is not a provenance difference.
    expect(d.provenance).toEqual([])
  })

  it('a CURRENT-schema revision reports the same credit note on the new keys too', () => {
    const d = finalAccountDifferences(stored(), credited())
    expect(d.figures.map(f => f.key)).toEqual(['invoicedToClient', 'creditedToClient', 'remainingToInvoice', 'invoicedToClientGross', 'receivablesOutstanding'])
    expect(d.provenance).toEqual(['clientCreditNotes'])
    expect(d.newMetrics).toEqual([])
    expect(d.newSources).toEqual([])
  })

  it('ABSENT is not NULL: a key the revision carries as null is a value and is compared', () => {
    const s = stored()
    s.figures = { ...s.figures, owedToClient: null }
    const d = finalAccountDifferences(s, compute())
    expect(d.figures.map(f => f.key)).toEqual(['owedToClient'])
    expect(d.newMetrics).toEqual([])
    // An explicitly undefined property is still carried (it cannot be stored, but it is not "absent").
    s.figures = { ...s.figures, owedToClient: undefined }
    expect(finalAccountDifferences(s, compute()).figures.map(f => f.key)).toEqual(['owedToClient'])
  })

  it('a not-comparable result carries the same empty lists', () => {
    expect(finalAccountDifferences(null, compute())).toEqual({ comparable: false, figures: [], rows: [], provenance: [], newMetrics: [], newSources: [], changed: false })
  })

  it('DRAFT agreement stays STRICT: a draft written by an older client lacks the new keys and never agrees', () => {
    expect(draftAgreesWith(stored({ status: 'draft' }), compute())).toBe(true)
    const old = legacy({ status: 'draft' })
    expect(finalAccountDifferences(old, compute()).changed).toBe(false)      // nothing it carries has moved…
    expect(draftAgreesWith(old, compute())).toBe(false)                      // …and it is still refused
    for (const key of FINAL_ACCOUNT_FIGURE_KEYS) {
      const s = stored({ status: 'draft' })
      expect(draftAgreesWith({ ...s, figures: without(s.figures, key) }, compute()), key).toBe(false)
    }
    // Missing register counts alone do not make a draft disagree (provenance is informational; budget apart).
    const s = stored({ status: 'draft' })
    expect(draftAgreesWith({ ...s, sources: { ...s.sources, counts: strip(s.sources.counts, NEW_SOURCES) } }, compute())).toBe(true)
  })

  it('the callable gates a draft through the strict function, and approval writes the server\'s full figure set', () => {
    const approve = stripComments(read('functions/src/finalAccount/approve.js'))
    expect(approve).toContain('if (!calc.draftAgreesWith(account, computation)) fail(CODE.FINAL_ACCOUNT_CHANGED)')
    expect(Object.keys(finalAccountContent(compute()).figures).sort()).toEqual([...FINAL_ACCOUNT_FIGURE_KEYS].sort())
  })

  it('an old-schema revision renders and exports its missing figures as NOT RECORDED — never zero, Unavailable or an outstanding balance', () => {
    const s = legacy()
    const html = renderToStaticMarkup(h(FinalAccountFigures, { figures: s.figures, currencyCode: 'AUD', differences: finalAccountDifferences(s, compute()) }))
    expect(html.match(/Not recorded</g)).toHaveLength(3)
    expect(html).toContain(NOT_RECORDED_NOTE)
    expect(html).not.toContain('Unavailable')
    expect(html).not.toContain('Current records:')
    expect(html).toContain('Credited to client')
    const csv = finalAccountCsv(s, { projectName: 'Harbour Road Units' })
    expect(csv).toContain(`"Credited to client","NOT RECORDED","AUD","ex-GST","${NOT_RECORDED_NOTE}"`)
    expect(csv).toContain('"Client retention held","NOT RECORDED"')
    expect(csv).toContain('"Owed to client","NOT RECORDED"')
    expect(csv).toContain('"Client invoices outstanding",2200.00,"AUD","gross (incl. GST)"')
    // A current-schema revision exports them as amounts.
    const current = finalAccountCsv(stored(), { projectName: 'Harbour Road Units' })
    expect(current).toContain('"Credited to client",0.00,"AUD","ex-GST"')
    expect(current).toContain('"Client retention held",0.00,"AUD","gross (incl. GST)","OUTSTANDING BALANCE — acknowledged at approval; Billed and withheld by the client — not receivable until released"')
    expect(current).not.toContain('NOT RECORDED')
    expect(figureText(undefined, FIGURE_BASIS.GROSS, 'AUD', { unrecorded: true })).toBe('Not recorded')
  })

  it('the page states "not recorded" for an approved revision and refuses to offer approval of an old-schema draft', () => {
    const page = read('src/pages/project/ProjectFinalAccount.jsx')
    expect(page).toContain('not recorded when this revision was approved')
    expect(page).toContain('not as a change')
    expect(stripComments(page)).toMatch(/isDraft && unrecordedCount > 0 \? 'This draft was prepared before figures that a Final Account now records were introduced\. Withdraw it and prepare a new draft\.'/)
  })
})

// ── 5. History and roles ─────────────────────────────────────────────────────

describe('revision history', () => {
  const rev = (number, status) => ({ id: String(number), number, status })

  it('the highest approved revision is current; earlier approved ones are superseded, unchanged', () => {
    const h1 = finalAccountHistory([rev(1, 'approved'), rev(2, 'withdrawn'), rev(3, 'approved'), rev(4, 'draft')])
    expect(h1.current.number).toBe(3)
    expect(h1.draft.number).toBe(4)
    expect(h1.canPrepare).toBe(false)
    expect(h1.nextNumber).toBe(5)
    expect(h1.list.map(a => [a.number, a.superseded, a.current])).toEqual([[4, false, false], [3, false, true], [2, false, false], [1, true, false]])
  })

  it('no revision → revision 1 can be prepared; a withdrawn draft frees the next number', () => {
    expect(finalAccountHistory([])).toMatchObject({ current: null, draft: null, nextNumber: 1, canPrepare: true })
    expect(finalAccountHistory([rev(1, 'withdrawn')])).toMatchObject({ current: null, nextNumber: 2, canPrepare: true })
    expect(finalAccountHistory([{ id: 'x', number: 'x', status: 'approved' }]).list).toEqual([])
  })

  it('qs prepares but never approves; an approver or the preparer withdraws a draft only', () => {
    expect(['company_admin', 'project_manager', 'qs'].map(canPrepareFinalAccount)).toEqual([true, true, true])
    expect(['company_admin', 'project_manager', 'qs', 'subcontractor', 'client', 'super_admin'].map(canApproveFinalAccount)).toEqual([true, true, false, false, false, false])
    const draft = { status: 'draft', createdBy: 'u_qs' }
    expect(canWithdrawFinalAccount('qs', draft, 'u_qs')).toBe(true)
    expect(canWithdrawFinalAccount('qs', draft, 'u_qs2')).toBe(false)
    expect(canWithdrawFinalAccount('project_manager', draft, 'u_pm')).toBe(true)
    expect(canWithdrawFinalAccount('company_admin', { status: 'approved', createdBy: 'u_qs' }, 'u_admin')).toBe(false)
    expect(canWithdrawFinalAccount('client', draft, 'u_qs')).toBe(false)
  })
})

// ── 6. Client actions (no SDK) ───────────────────────────────────────────────

describe('client actions', () => {
  const seen = { number: 2, status: 'draft', revision: 1, updatedAt: ts(10), updatedBy: 'u_qs' }

  it('approve sends identifiers and the seen revision ONLY — never an amount', async () => {
    const calls = []
    await runFinalAccountApprove({ call: async (d) => { calls.push(d); return { number: 2 } }, projectId: 'p1', seen: { ...seen, figures: { finalProfit: 1 } }, acknowledged: true })
    expect(calls).toEqual([{ projectId: 'p1', number: 2, expectedRevision: 1, acknowledged: true }])
  })

  it('approve refuses without acknowledgement, on a non-draft, and while the draft is still saving — before any call', async () => {
    const call = async () => { throw new Error('must not be called') }
    await expect(runFinalAccountApprove({ call, projectId: 'p1', seen, acknowledged: false })).rejects.toMatchObject({ kind: FINAL_ACCOUNT_ERROR.INVALID })
    await expect(runFinalAccountApprove({ call, projectId: 'p1', seen: { ...seen, status: 'approved' }, acknowledged: true })).rejects.toMatchObject({ kind: FINAL_ACCOUNT_ERROR.STALE })
    await expect(runFinalAccountApprove({ call, projectId: 'p1', seen: { ...seen, updatedAt: null }, acknowledged: true })).rejects.toMatchObject({ kind: FINAL_ACCOUNT_ERROR.PENDING })
  })

  it('callable refusals map to truthful kinds; an unknown failure is never reported as success', async () => {
    const kind = (details, code) => finalAccountCallableErrorKind({ details, code })
    expect(kind({ code: 'not-approver' })).toBe(FINAL_ACCOUNT_ERROR.PERMISSION)
    expect(kind({ code: 'final-account-not-ready' })).toBe(FINAL_ACCOUNT_ERROR.NOT_READY)
    expect(kind({ code: 'final-account-figures-changed' })).toBe(FINAL_ACCOUNT_ERROR.CHANGED)
    expect(kind({ code: 'final-account-stale' })).toBe(FINAL_ACCOUNT_ERROR.STALE)
    expect(kind({ code: 'final-account-busy' })).toBe(FINAL_ACCOUNT_ERROR.BUSY)
    expect(kind({ code: 'final-account-too-large' })).toBe(FINAL_ACCOUNT_ERROR.OVERSIZED)
    const call = async () => { const e = new Error('x'); e.details = { code: 'final-account-not-ready', blockers: ['costToComplete'] }; throw e }
    await expect(runFinalAccountApprove({ call, projectId: 'p1', seen, acknowledged: true }))
      .rejects.toMatchObject({ kind: FINAL_ACCOUNT_ERROR.NOT_READY, details: { blockers: ['costToComplete'] } })
  })

  it('NO ANSWER is an uncertain outcome — never "nothing was written"; only a typed refusal is certain', async () => {
    const kind = (code) => finalAccountCallableErrorKind({ code })
    for (const code of ['functions/deadline-exceeded', 'functions/unavailable', 'functions/internal', 'functions/unknown', 'functions/cancelled', undefined]) {
      expect(kind(code), String(code)).toBe(FINAL_ACCOUNT_ERROR.UNCERTAIN)
    }
    const uncertain = FINAL_ACCOUNT_ERROR_MESSAGES[FINAL_ACCOUNT_ERROR.UNCERTAIN]
    expect(uncertain).toMatch(/may still have completed/)
    expect(uncertain).toMatch(/repeating the request is safe/)
    expect(uncertain).not.toMatch(/[Nn]othing was (written|approved|changed)/)
    expect(FINAL_ACCOUNT_ERROR_MESSAGES[FINAL_ACCOUNT_ERROR.BUSY]).toMatch(/Nothing was approved/)
    const call = async () => { const e = new Error('deadline'); e.code = 'functions/deadline-exceeded'; throw e }
    await expect(runFinalAccountApprove({ call, projectId: 'p1', seen, acknowledged: true })).rejects.toMatchObject({ kind: FINAL_ACCOUNT_ERROR.UNCERTAIN })
  })

  it('the browser waits longer than the function may run, so the server answers first', () => {
    const index = read('functions/src/index.js')
    const serverSeconds = Number(index.slice(index.indexOf('export const FINAL_ACCOUNT_CALL_OPTIONS')).match(/timeoutSeconds:\s*(\d+)/)[1])
    expect(serverSeconds).toBe(120)
    expect(APPROVE_CALL_TIMEOUT_MS).toBeGreaterThan(serverSeconds * 1000)
    expect(stripComments(read('src/hooks/useFinalAccounts.jsx'))).toContain("httpsCallable(functions, 'approveFinalAccount', { timeout: APPROVE_CALL_TIMEOUT_MS })")
  })

  it('prepare and withdraw refuse without a user, and withdraw without a reason, before any read', async () => {
    const boom = () => { throw new Error('must not be called') }
    await expect(runFinalAccountPrepare({ uid: null, currencyCode: 'AUD', getDocsFromServer: boom })).rejects.toMatchObject({ kind: FINAL_ACCOUNT_ERROR.PERMISSION })
    await expect(runFinalAccountPrepare({ uid: 'u', currencyCode: 'aud', getDocsFromServer: boom })).rejects.toMatchObject({ kind: FINAL_ACCOUNT_ERROR.INVALID })
    await expect(runFinalAccountWithdraw({ uid: 'u', seen, reason: ' ', runTransaction: boom })).rejects.toMatchObject({ kind: FINAL_ACCOUNT_ERROR.INVALID })
  })

  it('the client modules contain no write of an approved status', () => {
    for (const f of ['src/lib/finalAccountActions.js', 'src/hooks/useFinalAccounts.jsx']) {
      const code = stripComments(read(f))
      expect(code, f).not.toMatch(/status:\s*FINAL_ACCOUNT_STATUS\.APPROVED|status:\s*'approved'/)
      expect(code, f).not.toMatch(/approvedAt:\s*serverTimestamp|approvedBy:\s*uid/)
    }
    const hook = stripComments(read('src/hooks/useFinalAccounts.jsx'))
    expect(hook).toContain("httpsCallable(functions, 'approveFinalAccount', {")
    // Writes only finalAccounts: the only doc() refs it builds for a write.
    expect(hook.match(/tx\.(set|update)|setDoc|updateDoc|addDoc|deleteDoc/g)).toBeNull()
  })
})

// ── 7. CSV ───────────────────────────────────────────────────────────────────

describe('CSV export', () => {
  it('an approved revision exports its identity, revision, currency, approver, date and the disclaimer', () => {
    const csv = finalAccountCsv(stored(), { projectName: 'Harbour Road Units' })
    expect(csv).toContain('"Constrap Final Account"')
    expect(csv).toContain('"Project","Harbour Road Units"')
    expect(csv).toContain('"Revision",1,"Current approved revision"')
    expect(csv).toContain('"Currency","AUD"')
    expect(csv).toContain('"Approved by","Pat PM"')
    expect(csv).toContain(new Date(1_763_000_000 * 1000).toISOString())
    expect(csv).toContain(FINAL_ACCOUNT_DISCLAIMER)
    expect(csv).toContain('"Final adjusted contract sum",12000.00,"AUD","ex-GST"')
    expect(csv).toContain('"Client invoices outstanding",2200.00,"AUD","gross (incl. GST)"')
    expect(csv).toContain('"Final margin",50.00,"%","%"')
    expect(csv).toContain('"03-100 — Concrete",4000.00,3500.00,500.00')
    expect(csv.endsWith('\r\n')).toBe(true)
    expect(finalAccountFilename(stored({ number: 3 }), 'Harbour Road Units')).toBe('constrap-final-account-harbour-road-units-revision-3.csv')
  })

  it('a draft or withdrawn revision is REFUSED — never exported as a finalised document', () => {
    expect(() => finalAccountCsv(stored({ status: 'draft' }))).toThrow(/approved/)
    expect(() => finalAccountCsv(stored({ status: 'withdrawn' }))).toThrow(/approved/)
    expect(() => finalAccountCsv(null)).toThrow()
  })

  it('formula injection in the basis, reference, names and cost codes is neutralised', () => {
    const s = stored({ reason: '=HYPERLINK("http://x","y")', reference: '+SUM(A1)', approvedByName: '@admin', preparedByName: '-2+3' })
    s.rows = [{ ...s.rows[0], costCodeName: '=cmd|\' /C calc\'!A0' }]
    const csv = finalAccountCsv(s, { projectName: '\t=1+1' })
    expect(csv).toContain('"\'=HYPERLINK(""http://x"",""y"")"')
    expect(csv).toContain('"\'+SUM(A1)"')
    expect(csv).toContain('"\'@admin"')
    expect(csv).toContain('"\'-2+3"')
    expect(csv).toContain('"\'=cmd|')
    expect(csv).toContain('"\'\t=1+1"')
  })

  it('the CSV carries the finalised labels and the corrected notes (an approved revision is never labelled a forecast)', () => {
    const csv = finalAccountCsv(stored())
    for (const label of ['"Final adjusted contract sum"', '"Final cost"', '"Final gross profit"', '"Final margin"']) expect(csv).toContain(label)
    expect(csv).not.toContain('Forecast')
    expect(csv).not.toContain('Gross approved value')
    expect(csv).toContain('Total approved value, ex-GST')
    expect(csv).toContain('positive balances of issued invoices')
  })

  it('a superseded revision says so; a self-approval is recorded; a null margin is "NOT CALCULABLE", a zero stays a zero', () => {
    const s = stored({ selfApproved: true })
    s.figures = { ...s.figures, finalMarginPct: null }
    const csv = finalAccountCsv(s, { superseded: true })
    expect(csv).toContain('SUPERSEDED by a later approved revision')
    expect(csv).toContain('self-approval')
    expect(csv).toContain('"Final margin","NOT CALCULABLE"')
    expect(csv).toContain('"Unallocated client receipts",0.00')
  })
})

// ── 8. Presentation ──────────────────────────────────────────────────────────

describe('presentation', () => {
  it('display states: loading —, missing Unavailable, null margin Not calculable, zero a formatted zero', () => {
    expect(figureText(null, FIGURE_BASIS.EX_GST, 'AUD', { pending: true })).toBe('—')
    expect(figureText(null, FIGURE_BASIS.EX_GST, 'AUD')).toBe('Unavailable')
    expect(figureText(null, FIGURE_BASIS.PERCENT, 'AUD', { nullable: true })).toBe('Not calculable')
    expect(figureText(0, FIGURE_BASIS.GROSS, 'AUD')).toMatch(/0\.00/)
    expect(figureText(NaN, FIGURE_BASIS.EX_GST, 'AUD')).toBe('Unavailable')
  })

  it('the figure view renders every figure in its basis group, marks outstanding balances and shows differences beside the stored value', () => {
    const s = stored()
    const live = compute(mutate(p => { p.baseline.originalContractValue = 10500 }))
    const html = renderToStaticMarkup(h(FinalAccountFigures, { figures: s.figures, currencyCode: 'AUD', differences: finalAccountDifferences(s, live) }))
    for (const def of FINAL_ACCOUNT_FIGURES) expect(html, def.key).toContain(def.label.replace(/&/g, '&amp;'))
    expect(html).toContain('Contract and revenue (ex-GST)')
    expect(html).toContain('Invoice balances and cash (gross, incl. GST)')
    expect(html).toContain('Outstanding balance')
    expect(html).toContain('$10,000.00')
    expect(html).toContain('Current records: $10,500.00')
    expect(html).toMatch(/<h3 id="fa-contract"/)
  })

  it('the LIVE view is labelled as a forecast — nothing on it is called "final"; a stored revision keeps the finalised labels', () => {
    const live = renderToStaticMarkup(h(FinalAccountFigures, { figures: EXPECTED_FIGURES, currencyCode: 'AUD', view: FIGURE_VIEW.LIVE }))
    for (const label of ['Adjusted contract sum', 'Forecast final cost', 'Forecast gross profit', 'Forecast margin']) expect(live).toContain(label)
    expect(live).not.toMatch(/\bFinal\b/)
    expect(live.replace(/[Ff]orecast final cost/g, '')).not.toMatch(/final/i)
    const stored = renderToStaticMarkup(h(FinalAccountFigures, { figures: EXPECTED_FIGURES, currencyCode: 'AUD' }))
    for (const label of ['Final adjusted contract sum', 'Final cost', 'Final gross profit', 'Final margin']) expect(stored).toContain(label)
    expect(stored).not.toContain('Forecast')
    // Same figures, same values, same keys — only the wording differs.
    expect(live).toContain('$12,000.00')
    expect(stored).toContain('$12,000.00')
  })

  it('a DRAFT is labelled as proposed — never "Final …" — and only an APPROVED revision gets the finalised labels', () => {
    const draft = renderToStaticMarkup(h(FinalAccountFigures, { figures: EXPECTED_FIGURES, currencyCode: 'AUD', view: FIGURE_VIEW.DRAFT }))
    for (const label of ['Proposed final contract sum', 'Proposed final cost', 'Proposed final gross profit', 'Proposed final margin']) expect(draft).toContain(label)
    expect(draft).not.toMatch(/>Final /)
    expect(draft).not.toContain('Forecast')
    expect(draft).toContain('Not final until approved')
    expect(draft).toContain('Not confirmed until approval')
    expect(draft).toContain('$6,000.00')                       // the same stored values
    expect(revisionView({ status: 'approved' })).toBe(FIGURE_VIEW.REVISION)
    for (const status of ['draft', 'withdrawn', undefined]) expect(revisionView({ status }), String(status)).toBe(FIGURE_VIEW.DRAFT)
    expect(revisionView(null)).toBe(FIGURE_VIEW.DRAFT)         // unknown is never shown as final
    const relabelled = FINAL_ACCOUNT_FIGURES.filter(d => figurePresentation(d, FIGURE_VIEW.DRAFT).label !== d.label).map(d => d.key)
    expect(relabelled).toEqual(['finalContractSum', 'finalCost', 'finalProfit', 'finalMarginPct'])
    // No "final" label reaches a view that is not an approved revision.
    for (const view of [FIGURE_VIEW.LIVE, FIGURE_VIEW.DRAFT]) {
      for (const d of FINAL_ACCOUNT_FIGURES) expect(figurePresentation(d, view).label, `${view}/${d.key}`).not.toMatch(/^Final /)
    }
  })

  it('the unapplied-variation requirement is worded in forecast-cost terms and distinguishes approved, applied and unapplied', () => {
    const check = READINESS_CHECKS.find(c => c.code === BLOCKER.UNAPPLIED_VARIATIONS)
    const text = readinessPresentation(check)
    expect(text.label).toBe('Every approved supplier variation is inside forecast final cost')
    expect(text.fix).toMatch(/approved supplier variation counts in forecast final cost only once it is applied to its purchase order or committed as new scope/)
    expect(text.fix).toMatch(/not yet applied, so its value is outside forecast final cost/)
    expect(`${text.label} ${text.fix}`).not.toMatch(/Final cost|\bgross\b/)
    // Every other requirement keeps its own wording; none of the SHOWN texts says "Final cost".
    for (const c of READINESS_CHECKS) {
      const shown = readinessPresentation(c)
      expect(`${shown.label} ${shown.fix}`, c.code).not.toMatch(/Final cost/)
      if (c.code !== BLOCKER.UNAPPLIED_VARIATIONS) expect(shown).toEqual({ label: c.label, fix: c.fix })
    }
  })

  it('every figure has a label and a note in both views, and only wording differs between them', () => {
    for (const def of FINAL_ACCOUNT_FIGURES) {
      for (const view of Object.values(FIGURE_VIEW)) {
        const t = figurePresentation(def, view)
        expect(t.label.length, def.key).toBeGreaterThan(3)
        expect(t.note.length, def.key).toBeGreaterThan(3)
      }
    }
    const relabelled = FINAL_ACCOUNT_FIGURES.filter(d => figurePresentation(d, FIGURE_VIEW.LIVE).label !== figurePresentation(d, FIGURE_VIEW.REVISION).label).map(d => d.key)
    expect(relabelled).toEqual(['finalContractSum', 'finalCost', 'finalProfit', 'finalMarginPct'])
    expect(figurePresentation(FINAL_ACCOUNT_FIGURES[0])).toEqual({ label: 'Original contract sum', note: 'From the Commercial baseline' })
  })

  it('the supplier variation note says what is and is not inside cost, and never says "gross"', () => {
    const def = FINAL_ACCOUNT_FIGURES.find(d => d.key === 'approvedSupplierVariations')
    const live = figurePresentation(def, FIGURE_VIEW.LIVE).note
    expect(live).toMatch(/Total approved value, ex-GST/)
    expect(live).toMatch(/applied to a purchase order or committed as new scope is inside forecast final cost/)
    expect(live).toMatch(/not yet applied is outside it and blocks approval/)
    const revision = figurePresentation(def, FIGURE_VIEW.REVISION).note
    expect(revision).toMatch(/all of it is inside final cost/)
    for (const note of [live, revision]) { expect(note).not.toMatch(/gross/i); expect(note).not.toMatch(/already inside/) }
  })

  it('"Client invoices outstanding" explains that it is positive balances and is not reduced by an over-allocated invoice', () => {
    const def = FINAL_ACCOUNT_FIGURES.find(d => d.key === 'receivablesOutstanding')
    for (const view of Object.values(FIGURE_VIEW)) {
      const note = figurePresentation(def, view).note
      expect(note).toMatch(/positive balances of issued invoices/)
      expect(note).toMatch(/over-allocated invoice does not reduce it/)
    }
  })

  it('a missing figure renders Unavailable — never $0.00', () => {
    const html = renderToStaticMarkup(h(FinalAccountFigures, { figures: { ...EXPECTED_FIGURES, actualCost: null }, currencyCode: 'AUD' }))
    expect(html).toContain('Unavailable')
  })

  it('the rows table is a captioned table with row and column headers; no budget line is said, not zeroed', () => {
    const html = renderToStaticMarkup(h(FinalAccountRows, { rows: [...compute().rows, { costCodeId: 'x', costCodeName: 'Unbudgeted', approvedBudget: null, actualCost: 5, variance: null }], currencyCode: 'AUD' }))
    expect(html).toContain('<caption')
    expect(html).toContain('scope="col"')
    expect(html).toContain('scope="row"')
    expect(html).toContain('No budget line')
    expect(renderToStaticMarkup(h(FinalAccountRows, { rows: [], currencyCode: 'AUD' }))).toContain('No cost code')
  })

  it('the approve dialog states the disclaimer, names a self-approval, lists every outstanding balance and starts unacknowledged', () => {
    const html = renderToStaticMarkup(h(ApproveFinalAccountModal, { account: stored({ status: 'draft' }), currencyCode: 'AUD', selfApproval: true, onApprove() {}, onClose() {} }))
    expect(html).toContain('role="dialog"')
    expect(html).toContain('aria-modal="true"')
    expect(html).toContain(FINAL_ACCOUNT_DISCLAIMER)
    expect(html).toContain('self-approval')
    for (const item of openItemsOf(EXPECTED_FIGURES)) expect(html).toContain(item.label)
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Approve revision<\/button>/)
    expect(html).toContain('type="checkbox"')
  })

  it('the prepare dialog asks for the basis and the acknowledgement', () => {
    const html = renderToStaticMarkup(h(PrepareFinalAccountModal, { number: 2, figures: EXPECTED_FIGURES, currencyCode: 'AUD', onPrepare() {}, onClose() {} }))
    expect(html).toContain('Revision 2')
    expect(html).toContain('for="fa-reason"')
    expect(html).toContain('What this revision corrects')
    expect(html).toContain('for="fa-prepare-ack"')
  })
})

// ── 9. Page, navigation and print (source) ───────────────────────────────────

describe('page wiring', () => {
  const page = read('src/pages/project/ProjectFinalAccount.jsx')
  const code = stripComments(page)

  it('lives under Commercial as a sub-tab — no new project tab', () => {
    const app = read('src/App.jsx')
    expect(app).toMatch(/<Route path="final-account" element=\{<ProjectFinalAccount \/>\} \/>/)
    const commercial = app.slice(app.indexOf('<Route path="commercial"'), app.indexOf('<Route path="documents"'))
    expect(commercial).toContain('final-account')
    expect(read('src/layouts/ProjectCommercialLayout.jsx')).toContain("{ to: 'final-account',     label: 'Final Account',     end: false }")
    expect(read('src/lib/projectTabs.js')).not.toMatch(/final-account|Final Account/)
  })

  it('opens no financial read for a non-financial role (the gate is in the outer component)', () => {
    const outer = code.slice(code.indexOf('export default function ProjectFinalAccount'))
    expect(outer).toMatch(/isFinancialRole\(profile\?\.role\)/)
    expect(outer).not.toMatch(/use(BudgetLines|PurchaseOrders|FinalAccounts|ClientInvoices)\(/)
    expect(outer.indexOf('isFinancialRole')).toBeLessThan(outer.indexOf('<FinalAccount '))
  })

  it('approve, withdraw and prepare are offered through the role helpers; export and print only for an approved revision', () => {
    expect(code).toMatch(/const mayApprove = canApproveFinalAccount\(role\) && isDraft/)
    expect(code).toMatch(/const mayWithdraw = canWithdrawFinalAccount\(role, selected, currentUid\)/)
    expect(code).toMatch(/const mayPrepare = canPrepareFinalAccount\(role\)/)
    expect(code).toMatch(/\{isApproved && <Btn variant="ghost" onClick=\{handleExport\}>Export CSV<\/Btn>\}/)
    expect(code).toMatch(/\{isApproved && <Btn variant="ghost" onClick=\{\(\) => window\.print\(\)\}>Print \/ Save as PDF<\/Btn>\}/)
    // The printable class is applied to an approved revision only.
    expect(code).toContain("className={`${isApproved ? 'commercial-report ' : ''}flex flex-col gap-4`}")
  })

  it('the page performs no money arithmetic and formats only through the shared formatters', () => {
    for (const f of ['src/pages/project/ProjectFinalAccount.jsx', 'src/pages/project/finalAccount/FinalAccountSnapshot.jsx', 'src/pages/project/finalAccount/FinalAccountDialogs.jsx']) {
      const c = stripComments(read(f))
      expect(c, f).not.toMatch(/roundMoney|toFixed\(|\.reduce\(/)
      expect(c, f).not.toMatch(/['"]\$|[>\s]\$\d|'AUD'|"AUD"/)
      expect(c, f).not.toMatch(/style=\{\{/)
      expect(c, f).not.toMatch(/from 'firebase\//)
    }
  })

  it('states the internal-approval disclaimer, the draft warning and the live-difference warning with status / alert roles', () => {
    expect(page).toContain('{FINAL_ACCOUNT_DISCLAIMER}')
    expect(page).toContain('DRAFT — not approved.')
    expect(page).toMatch(/role="alert">\s*The current project records differ from this approved revision/)
    expect(page).toContain('The approved figures are unchanged')
    expect(FINAL_ACCOUNT_DISCLAIMER).toMatch(/not a client agreement, a contractual certificate, a tax document or proof of payment/)
  })

  it('the CSV goes through the ONE object-URL path and the print rules are the L2-A rules, unchanged', () => {
    expect(code).toMatch(/import \{ saveBlob \} from '..\/..\/lib\/fileBlob'/)
    expect(code).not.toMatch(/createObjectURL|getDownloadURL/)
    const css = read('src/index.css')
    expect(css).not.toMatch(/final-account/)
    expect(css).toContain('body:has(.commercial-report) [data-print-hide]')
    expect(read('src/layouts/ProjectCommercialLayout.jsx')).toContain('<nav data-print-hide')
  })

  it('the status vocabulary is exactly draft / approved / withdrawn', () => {
    expect(Object.values(FINAL_ACCOUNT_STATUS)).toEqual(['draft', 'approved', 'withdrawn'])
  })
})
