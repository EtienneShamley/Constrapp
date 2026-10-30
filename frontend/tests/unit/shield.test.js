import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  evaluateShield, summariseShield, groupChecks,
  SHIELD_STATE, SHIELD_STATE_ORDER, SHIELD_STATE_LABELS, CHECK, CHECK_ORDER, CHECK_DEPENDENCIES,
  CHECK_LINKS, SHIELD_SOURCES, SHIELD_SOURCE_LABELS, NEEDS_DATA_REASON, INTEGRITY_ISSUE,
  STATE_CONFLICT, EXCEPTION_KIND,
} from '../../src/lib/shield'
import { PULSE_STATE } from '../../src/lib/pulse'
import { FIGURE_STATE, SNAPSHOT_SOURCES, projectSnapshot } from '../../src/lib/projectSnapshot'
import { postedInvoicedByPoLine, postedInvoicedByPo, invoiceTotals, SI_COUNTING_STATUSES } from '../../src/lib/supplierInvoices'
import { allocationExceptions, payablesSummary, overReconciledPayableRows } from '../../src/lib/supplierPayments'
import { creditNoteExceptions } from '../../src/lib/supplierCreditNotes'
import { releaseExceptions, overReleasedRows, retentionInvoiceRows, releasedByInvoiceId } from '../../src/lib/retention'
import { approvedSupplierVariationsTotal, appliedSupplierVariationAdjustments } from '../../src/lib/variations'
import { FINANCIAL_ROLES } from '../../src/lib/margin'
import { PROJECT_TABS } from '../../src/lib/projectTabs'
import { MODULE_NAMES } from '../../src/lib/moduleBranding'

// ── Constrapp SHIELD™ foundation (ADR-50) ────────────────────────────────────
//
// SHIELD is a read-only composition of existing selectors. These tests pin:
//
//   1. every check's five states — loading, unavailable, needs data, finding,
//      no issue — and that a loading, failed or MISSING source can never yield
//      "no issue";
//   2. the dependency map, VERIFIED BY PERTURBATION against the real selectors
//      (every declared source moves the check; no undeclared source does);
//   3. financial consistency — every SHIELD figure IS postedInvoicedByPoLine /
//      postedInvoicedByPo / invoiceTotals / allocationExceptions /
//      creditNoteExceptions / releaseExceptions / overReleasedRows /
//      payablesSummary output for the same fixture; inputs are never mutated;
//   4. the domain rules: supplier identity (id first, legacy name second, never
//      mixed), normalised references, cancelled records ignored, cent
//      comparisons, drafts never integrity failures, line vs PO-level excess
//      kept separate, approved supplier variations as context only, the four
//      approved state conflicts, one row per underlying exception;
//   5. page wiring and roles, as SOURCE STRUCTURE (no DOM runner — ADR-26).

const read = (rel) =>
  readFileSync(fileURLToPath(new URL(`../../src/${rel}`, import.meta.url)), 'utf8')
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '')

// ── Fixture ──────────────────────────────────────────────────────────────────
//
// Built so that EVERY declared source moves its check, and so that all five
// checks land on FINDING with every approved sub-condition represented at
// least once. Totals are internally consistent unless a comment says otherwise.

const inv = (over) => ({
  currency: 'AUD', retention: 0, retentionGst: 0, retentionTotal: 0, source: 'direct_po', ...over,
})
const totals = (subtotal, gstTotal, retention = 0) => {
  const t = invoiceTotals([{ amount: subtotal, gstAmount: gstTotal }], retention)
  return { subtotal: t.subtotal, gstTotal: t.gstTotal, grossTotal: t.grossTotal, retention: t.retention,
    retentionGst: t.retentionGst, retentionTotal: t.retentionTotal, net: t.net, payableGst: t.payableGst, payableTotal: t.payableTotal }
}

const inv1 = inv({
  id: 'inv1', invoiceNumber: 'SI-0001', supplierInvoiceNumber: 'INV-100', status: 'posted',
  supplierId: 'sup1', supplierName: 'Ace Concrete', poId: 'po1', poNumber: 'PO-0001', invoiceDate: '2026-01-10', dueDate: '2026-02-10',
  lineItems: [
    { poLineIndex: 0, costCodeId: 'cc1', costCodeName: '03-100 — Concrete', description: 'Slab', amount: 600, taxCode: 'gst', gstAmount: 60 },
    { poLineIndex: 1, costCodeId: 'cc2', costCodeName: '03-200 — Formwork', description: 'Forms', amount: 400, taxCode: 'gst', gstAmount: 40 },
  ],
  ...totals(1000, 100),
})
// Retained invoice on PO-0005: payable 44 on a gross 55.
const inv2 = inv({
  id: 'inv2', invoiceNumber: 'SI-0002', supplierInvoiceNumber: 'INV-200', status: 'posted',
  supplierId: 'sup2', supplierName: 'Beta Steel', poId: 'po5', poNumber: 'PO-0005', invoiceDate: '2026-01-12',
  lineItems: [{ poLineIndex: 0, costCodeId: 'cc6', costCodeName: '06-100 — Steel', description: 'Mesh', amount: 50, taxCode: 'gst', gstAmount: 5 }],
  ...totals(50, 5, 10),
})
// Same supplier id as inv1, reference " inv-100 " — normalises to the same key.
const inv3 = inv({
  id: 'inv3', invoiceNumber: 'SI-0003', supplierInvoiceNumber: ' inv-100 ', status: 'posted',
  supplierId: 'sup1', supplierName: 'ACE CONCRETE', poId: 'po1', poNumber: 'PO-0001', invoiceDate: '2026-02-01',
  lineItems: [{ poLineIndex: 1, costCodeId: 'cc2', costCodeName: '03-200 — Formwork', description: 'Extra forms', amount: 300, taxCode: 'gst', gstAmount: 30 }],
  ...totals(300, 30),
})
const inv4 = inv({
  id: 'inv4', invoiceNumber: 'SI-0004', supplierInvoiceNumber: 'INV-400', status: 'posted',
  supplierId: 'sup2', supplierName: 'Beta Steel', poId: 'po1', poNumber: 'PO-0001', invoiceDate: '2026-02-05',
  lineItems: [{ poLineIndex: 0, costCodeId: 'cc1', costCodeName: '03-100 — Concrete', description: 'Pump', amount: 500, taxCode: 'gst', gstAmount: 50 }],
  ...totals(500, 50),
})
// A DRAFT sharing inv1's reference: part of the duplicate group, never an
// integrity failure, never counted anywhere financially.
const inv5 = inv({
  id: 'inv5', invoiceNumber: 'SI-0005', supplierInvoiceNumber: 'INV-100', status: 'draft',
  supplierId: 'sup1', supplierName: 'Ace Concrete', poId: 'po1', poNumber: 'PO-0001', invoiceDate: '2026-02-20',
  lineItems: [{ poLineIndex: 0, costCodeId: 'cc1', costCodeName: '03-100 — Concrete', description: 'Draft', amount: 999, taxCode: 'gst', gstAmount: 99.9 }],
  subtotal: 1, gstTotal: 0, grossTotal: 1, net: 1, payableGst: 0, payableTotal: 1, // deliberately inconsistent — drafts are not assessed
})
// Legacy (supplierId: null) pair matched on the frozen name; inv6 is posted
// against a CANCELLED PO (state conflict A).
const inv6 = inv({
  id: 'inv6', invoiceNumber: 'SI-0006', supplierInvoiceNumber: 'G-1', status: 'posted',
  supplierId: null, supplierName: 'Gamma Plumbing', poId: 'po2', poNumber: 'PO-0002', invoiceDate: '2026-01-20',
  lineItems: [{ poLineIndex: 0, costCodeId: 'cc3', costCodeName: '07-100 — Plumbing', description: 'Rough-in', amount: 200, taxCode: 'gst', gstAmount: 20 }],
  ...totals(200, 20),
})
const inv6b = inv({
  id: 'inv6b', invoiceNumber: 'SI-0007', supplierInvoiceNumber: 'g - 1', status: 'posted',
  supplierId: null, supplierName: 'gamma  plumbing', poId: 'po5', poNumber: 'PO-0005', invoiceDate: '2026-01-25',
  lineItems: [{ poLineIndex: 0, costCodeId: 'cc6', costCodeName: '06-100 — Steel', description: 'Brackets', amount: 10, taxCode: 'gst', gstAmount: 1 }],
  ...totals(10, 1),
})
// Two APPROVED (not counting) invoices for one claim (state conflict D).
const inv7 = inv({
  id: 'inv7', invoiceNumber: 'SI-0008', supplierInvoiceNumber: 'INV-700', status: 'approved', source: 'progress_claim',
  supplierId: 'sup2', supplierName: 'Beta Steel', poId: 'po5', poNumber: 'PO-0005', progressClaimId: 'cl1', claimNumber: 'PC-0001',
  lineItems: [{ poLineIndex: 0, costCodeId: 'cc6', costCodeName: '06-100 — Steel', description: 'Claim 1', amount: 30, taxCode: 'gst', gstAmount: 3 }],
  ...totals(30, 3),
})
const inv8 = { ...inv7, id: 'inv8', invoiceNumber: 'SI-0009', supplierInvoiceNumber: 'INV-800' }
// Stored payableTotal 20 disagrees with its lines (11) — integrity mismatch.
const inv9 = inv({
  id: 'inv9', invoiceNumber: 'SI-0010', supplierInvoiceNumber: 'INV-900', status: 'posted',
  supplierId: 'sup2', supplierName: 'Beta Steel', poId: 'po5', poNumber: 'PO-0005', invoiceDate: '2026-02-08',
  lineItems: [{ poLineIndex: 0, costCodeId: 'cc6', costCodeName: '06-100 — Steel', description: 'Bolts', amount: 10, taxCode: 'gst', gstAmount: 1 }],
  ...totals(10, 1), payableTotal: 20,
})
// Consistent totals, but the second counted line carries NO cost code.
const inv10 = inv({
  id: 'inv10', invoiceNumber: 'SI-0011', supplierInvoiceNumber: 'INV-1000', status: 'posted',
  supplierId: 'sup2', supplierName: 'Beta Steel', poId: 'po5', poNumber: 'PO-0005', invoiceDate: '2026-02-09',
  lineItems: [
    { poLineIndex: 0, costCodeId: 'cc6', costCodeName: '06-100 — Steel', description: 'Washers', amount: 5, taxCode: 'gst_free', gstAmount: 0 },
    { poLineIndex: 0, costCodeId: '', costCodeName: '', description: 'Freight', amount: 5, taxCode: 'gst_free', gstAmount: 0 },
  ],
  ...totals(10, 0),
})
// Malformed: no line items, blank supplier reference.
const inv11 = inv({
  id: 'inv11', invoiceNumber: 'SI-0012', supplierInvoiceNumber: '', status: 'posted',
  supplierId: 'sup2', supplierName: 'Beta Steel', poId: 'po5', poNumber: 'PO-0005', invoiceDate: '2026-02-10',
  lineItems: [], ...totals(0, 0),
})
// Cancelled: ignored by every check.
const inv12 = { ...inv1, id: 'inv12', invoiceNumber: 'SI-0013', status: 'cancelled' }

const SOURCES = {
  purchaseOrders: [
    { id: 'po1', poNumber: 'PO-0001', status: 'sent', supplierId: 'sup1', supplierName: 'Ace Concrete', subtotal: 1200, lineItems: [
      { costCodeId: 'cc1', costCodeName: '03-100 — Concrete', description: 'Slab', lineTotal: 800 },
      { costCodeId: 'cc2', costCodeName: '03-200 — Formwork', description: 'Forms', lineTotal: 400 },
    ] },
    { id: 'po2', poNumber: 'PO-0002', status: 'cancelled', subtotal: 500, lineItems: [{ costCodeId: 'cc3', costCodeName: '07-100 — Plumbing', description: 'Rough-in', lineTotal: 500 }] },
    { id: 'po3', poNumber: 'PO-0003', status: 'closed', subtotal: 300, lineItems: [{ costCodeId: 'cc4', costCodeName: '09-100 — Paint', description: 'Paint', lineTotal: 300 }] },
    { id: 'po4', poNumber: 'PO-0004', status: 'sent', subtotal: 1000, lineItems: [{ costCodeId: 'cc5', costCodeName: '05-100 — Roof', description: 'Roof', lineTotal: 1000 }] },
    { id: 'po5', poNumber: 'PO-0005', status: 'sent', subtotal: 100, lineItems: [{ costCodeId: 'cc6', costCodeName: '06-100 — Steel', description: 'Steel', lineTotal: 100 }] },
  ],
  progressClaims: [
    { id: 'cl1', claimNumber: 'PC-0001', status: 'approved',  poId: 'po5', poNumber: 'PO-0005', approvedSubtotal: 30,  claimedSubtotal: 30 },
    { id: 'cl2', claimNumber: 'PC-0002', status: 'approved',  poId: 'po2', poNumber: 'PO-0002', approvedSubtotal: 500, claimedSubtotal: 500 },
    { id: 'cl3', claimNumber: 'PC-0003', status: 'submitted', poId: 'po3', poNumber: 'PO-0003', claimedSubtotal: 100 },
    { id: 'cl4', claimNumber: 'PC-0004', status: 'draft',     poId: 'po4', poNumber: 'PO-0004', claimedSubtotal: 50 },
    { id: 'cl5', claimNumber: 'PC-0005', status: 'submitted', poId: 'po4', poNumber: 'PO-0004', claimedSubtotal: 60 },
    { id: 'cl6', claimNumber: 'PC-0006', status: 'rejected',  poId: 'po5', poNumber: 'PO-0005', claimedSubtotal: 7 },
  ],
  supplierInvoices: [inv1, inv2, inv3, inv4, inv5, inv6, inv6b, inv7, inv8, inv9, inv10, inv11, inv12],
  supplierCreditNotes: [
    // Valid: reduces inv1's remaining payable by 110.
    { id: 'cn1', creditNumber: 'SCN-0001', status: 'posted', supplierInvoiceId: 'inv1', invoiceNumber: 'SI-0001',
      supplierId: 'sup1', supplierName: 'Ace Concrete', currency: 'AUD',
      lineItems: [{ costCodeId: 'cc1', costCodeName: '03-100 — Concrete', description: 'Credit', amount: 100, taxCode: 'gst', gstAmount: 10 }],
      subtotal: 100, gstTotal: 10, grossTotal: 110 },
    // Invalid: its target withholds retention — counts nothing, listed as an exception.
    { id: 'cn2', creditNumber: 'SCN-0002', status: 'posted', supplierInvoiceId: 'inv2', invoiceNumber: 'SI-0002',
      supplierId: 'sup2', supplierName: 'Beta Steel', currency: 'AUD',
      lineItems: [{ costCodeId: 'cc6', costCodeName: '06-100 — Steel', description: 'Credit', amount: 10, taxCode: 'gst', gstAmount: 1 }],
      subtotal: 10, gstTotal: 1, grossTotal: 11 },
  ],
  supplierPayments: [
    // Over-reconciles inv1: basis 1100, settled 1500 + 110 credit.
    { id: 'sp1', paymentNumber: 'SP-0001', status: 'posted', supplierId: 'sup1', supplierName: 'Ace Concrete', amount: 1500, allocatedTotal: 1500, unallocatedAmount: 0,
      allocations: [{ supplierInvoiceId: 'inv1', invoiceNumber: 'SI-0001', allocatedAmount: 1500 }] },
    // Allocation to another supplier's invoice — allocation exception.
    { id: 'sp2', paymentNumber: 'SP-0002', status: 'posted', supplierId: 'sup2', supplierName: 'Beta Steel', amount: 10, allocatedTotal: 10, unallocatedAmount: 0,
      allocations: [{ supplierInvoiceId: 'inv1', invoiceNumber: 'SI-0001', allocatedAmount: 10 }] },
    // Allocation to a DRAFT invoice — allocation exception (not payable).
    { id: 'sp3', paymentNumber: 'SP-0003', status: 'posted', supplierId: 'sup1', supplierName: 'Ace Concrete', amount: 5, allocatedTotal: 5, unallocatedAmount: 0,
      allocations: [{ supplierInvoiceId: 'inv5', invoiceNumber: 'SI-0005', allocatedAmount: 5 }] },
    { id: 'sp4', paymentNumber: 'SP-0004', status: 'draft', supplierId: 'sup1', supplierName: 'Ace Concrete', amount: 9999, allocatedTotal: 9999, unallocatedAmount: 0,
      allocations: [{ supplierInvoiceId: 'inv1', invoiceNumber: 'SI-0001', allocatedAmount: 9999 }] }, // draft: moves nothing
  ],
  retentionReleases: [
    { id: 'rr1', releaseNumber: 'RR-0001', status: 'posted', supplierInvoiceId: 'inv2', invoiceNumber: 'SI-0002', amount: 10, gstAmount: 1, releaseTotal: 11 },
    // Over-releases inv2 (retentionTotal 11; released 16.50).
    { id: 'rr2', releaseNumber: 'RR-0002', status: 'posted', supplierInvoiceId: 'inv2', invoiceNumber: 'SI-0002', amount: 5, gstAmount: 0.5, releaseTotal: 5.5 },
    // Targets an invoice holding no retention — release exception.
    { id: 'rr3', releaseNumber: 'RR-0003', status: 'posted', supplierInvoiceId: 'inv4', invoiceNumber: 'SI-0004', amount: 1, gstAmount: 0.1, releaseTotal: 1.1 },
    { id: 'rr4', releaseNumber: 'RR-0004', status: 'draft',  supplierInvoiceId: 'inv4', invoiceNumber: 'SI-0004', amount: 1, gstAmount: 0.1, releaseTotal: 1.1 }, // draft: not released
  ],
  variations: [
    { id: 'v1', variationNumber: 'SV-0001', variationType: 'supplier', status: 'approved',  poId: 'po1', approvedSubtotal: 250, submittedSubtotal: 250, lineItems: [] },
    { id: 'v2', variationNumber: 'SV-0002', variationType: 'supplier', status: 'submitted', poId: 'po1', submittedSubtotal: 99,  lineItems: [] },
    { id: 'v3', variationNumber: 'CV-0001', variationType: 'client',   status: 'approved',  poId: 'po1', approvedSubtotal: 5000, lineItems: [] }, // client: never PO context
    { id: 'v4', variationNumber: 'SV-0003', variationType: 'supplier', status: 'approved',  poId: 'po5', approvedSubtotal: -20, lineItems: [] },
    // ADR-62: APPLIED to po3 but its line names cost code cc9 where po3 line 0 is
    // cc4 — a cost-code mismatch. Nothing matures (no adjustment on po3); the
    // line is check 4 condition F, which makes `variations` a DECLARED source.
    { id: 'v5', variationNumber: 'SV-0004', variationType: 'supplier', status: 'approved',  poId: 'po3', poNumber: 'PO-0003', approvedSubtotal: 40,
      commitmentAppliedAt: { seconds: 1, nanoseconds: 0 }, commitmentAppliedBy: 'u_qs',
      lineItems: [{ costCodeId: 'cc9', costCodeName: '99-100 — Other', poLineIndex: 0, approvedAmount: 40 }] },
  ],
}

const settled = (loading = false, error = false) => ({ loading, error })
const allSettled = () => Object.fromEntries(SHIELD_SOURCES.map(s => [s, settled()]))
const withState = (overrides) => ({ ...allSettled(), ...overrides })

const run = (sources = SOURCES, sourceStates = allSettled(), currencyCode = 'AUD') =>
  evaluateShield({ sources, sourceStates, currencyCode })
const byId = (result) => Object.fromEntries(result.checks.map(c => [c.id, c]))
const get = (id, sources, sourceStates) => byId(run(sources, sourceStates))[id]

const emptied = (source) => ({ ...SOURCES, [source]: [] })
const EMPTY = Object.fromEntries(SHIELD_SOURCES.map(s => [s, []]))

const CONTRACT_KEYS = [
  'id', 'title', 'links', 'state', 'failedSources', 'reason', 'headline', 'explanation',
  'values', 'evidence', 'evidenceColumns', 'caveats',
]

// ── 0 · Shape ────────────────────────────────────────────────────────────────

describe('evaluateShield — shape', () => {
  const result = run()

  it('returns the five checks in the fixed order, each with the contract fields', () => {
    expect(result.checks.map(c => c.id)).toEqual(CHECK_ORDER)
    expect(CHECK_ORDER).toHaveLength(5)
    expect(new Set(Object.values(CHECK))).toEqual(new Set(CHECK_ORDER))
    for (const c of result.checks) {
      expect(Object.keys(c).sort()).toEqual([...CONTRACT_KEYS].sort())
      expect(typeof c.title).toBe('string')
      expect(Array.isArray(c.links) && c.links.length > 0).toBe(true)
      expect(Array.isArray(c.evidence)).toBe(true)
      expect(Array.isArray(c.caveats)).toBe(true)
      expect(SHIELD_STATE_ORDER).toContain(c.state)
    }
  })

  it('carries the project currency through unchanged — never a default', () => {
    expect(result.currencyCode).toBe('AUD')
    expect(run(SOURCES, allSettled(), 'NZD').currencyCode).toBe('NZD')
    expect(run(SOURCES, allSettled(), 'JPY').currencyCode).toBe('JPY')
  })

  it('the fixture lands every check on a finding (no trivial pass), and the empty project on needs data', () => {
    for (const c of result.checks) expect(c.state, c.id).toBe(SHIELD_STATE.FINDING)
    for (const c of run(EMPTY).checks) {
      expect(c.state, c.id).toBe(SHIELD_STATE.NEEDS_DATA)
      expect(c.reason, c.id).toBe(NEEDS_DATA_REASON.NO_RECORDS)
      expect(c.evidence, c.id).toEqual([])
    }
  })

  it('summary is counts by state that sum to five — and nothing else', () => {
    const s = summariseShield(result.checks)
    expect(Object.keys(s)).toEqual(['counts', 'total'])
    expect(Object.keys(s.counts)).toEqual(SHIELD_STATE_ORDER)
    expect(Object.values(s.counts).reduce((a, b) => a + b, 0)).toBe(5)
    expect(s.total).toBe(5)
    expect(result.summary).toEqual(s)
  })

  it('groupChecks partitions by state, preserving check order', () => {
    const mixed = run(SOURCES, withState({ variations: settled(true), supplierPayments: settled(false, true) }))
    const g = groupChecks(mixed.checks)
    expect(Object.keys(g)).toEqual(SHIELD_STATE_ORDER)
    for (const s of SHIELD_STATE_ORDER) for (const c of g[s]) expect(c.state).toBe(s)
    const all = SHIELD_STATE_ORDER.flatMap(s => g[s].map(c => c.id))
    expect(all.sort()).toEqual([...CHECK_ORDER].sort())
    const findings = g[SHIELD_STATE.FINDING].map(c => c.id)
    expect(findings).toEqual(CHECK_ORDER.filter(id => findings.includes(id)))
  })

  it('every link targets an existing project tab (tab-level — no invented record deep links)', () => {
    const tabs = PROJECT_TABS.map(t => t.to)
    for (const [id, links] of Object.entries(CHECK_LINKS)) {
      for (const link of links) {
        expect(tabs, id).toContain(link.to.split('/')[0])
        expect(link.to, id).not.toMatch(/[?:]/)
        expect(link.label).toMatch(/^Open /)
      }
    }
    for (const c of result.checks) expect(c.links).toBe(CHECK_LINKS[c.id])
  })

  it('SHIELD sources are a strict subset of the snapshot sources, all labelled; no forecast, budget, baseline or programme source', () => {
    for (const s of SHIELD_SOURCES) {
      expect(SNAPSHOT_SOURCES).toContain(s)
      expect(SHIELD_SOURCE_LABELS[s], s).toEqual(expect.any(String))
    }
    for (const s of ['budgetLines', 'forecastLines', 'baseline', 'activities', 'costCodes']) {
      expect(SHIELD_SOURCES).not.toContain(s)
    }
    for (const deps of Object.values(CHECK_DEPENDENCIES)) for (const d of deps) expect(SHIELD_SOURCES).toContain(d)
  })

  it('the state vocabulary is the PULSE vocabulary (ADR-47), labelled', () => {
    expect(SHIELD_STATE).toEqual(PULSE_STATE)
    expect(SHIELD_STATE.LOADING).toBe(FIGURE_STATE.LOADING)
    expect(SHIELD_STATE.UNAVAILABLE).toBe(FIGURE_STATE.UNAVAILABLE)
    for (const s of SHIELD_STATE_ORDER) expect(SHIELD_STATE_LABELS[s]).toEqual(expect.any(String))
  })

  it('never mutates its inputs', () => {
    const before = JSON.stringify(SOURCES)
    const frozen = JSON.parse(before)
    const deepFreeze = (o) => { if (o && typeof o === 'object') { Object.freeze(o); Object.values(o).forEach(deepFreeze) } return o }
    deepFreeze(frozen)
    expect(() => run(frozen)).not.toThrow()
    run()
    expect(JSON.stringify(SOURCES)).toBe(before)
  })
})

// ── 1 · Availability: loading / failed / missing never become "no issue" ─────

describe('availability — a loading, failed or missing dependency never yields no issue', () => {
  for (const id of CHECK_ORDER) {
    for (const dep of CHECK_DEPENDENCIES[id]) {
      it(`${id}: ${dep} loading → LOADING, no evidence, no values`, () => {
        const c = get(id, SOURCES, withState({ [dep]: settled(true) }))
        expect(c.state).toBe(SHIELD_STATE.LOADING)
        expect(c.evidence).toEqual([])
        expect(c.values).toEqual({})
        expect(c.headline).toBe('')
      })
      it(`${id}: ${dep} failed → UNAVAILABLE naming it`, () => {
        const c = get(id, SOURCES, withState({ [dep]: settled(false, true) }))
        expect(c.state).toBe(SHIELD_STATE.UNAVAILABLE)
        expect(c.failedSources).toEqual([dep])
        expect(c.evidence).toEqual([])
      })
      it(`${id}: ${dep} MISSING from sourceStates → UNAVAILABLE (missing is never success)`, () => {
        const states = allSettled()
        delete states[dep]
        const c = get(id, SOURCES, states)
        expect(c.state).toBe(SHIELD_STATE.UNAVAILABLE)
        expect(c.failedSources).toEqual([dep])
      })
      it(`${id}: ${dep} failed on an EMPTY project is still UNAVAILABLE, never needs data or no issue`, () => {
        const c = get(id, EMPTY, withState({ [dep]: settled(false, true) }))
        expect(c.state).toBe(SHIELD_STATE.UNAVAILABLE)
      })
    }
  }

  it('a failure outranks loading, and names only the failed sources', () => {
    const c = get(CHECK.FINANCIAL_EXCEPTIONS, SOURCES, withState({
      supplierInvoices: settled(true), supplierPayments: settled(false, true), retentionReleases: settled(false, true),
    }))
    expect(c.state).toBe(SHIELD_STATE.UNAVAILABLE)
    expect(c.failedSources).toEqual(['supplierPayments', 'retentionReleases'])
  })

  it('with every source failed, no check is "no issue" and none is a finding', () => {
    const states = Object.fromEntries(SHIELD_SOURCES.map(s => [s, settled(false, true)]))
    for (const c of run(SOURCES, states).checks) expect(c.state).toBe(SHIELD_STATE.UNAVAILABLE)
    for (const c of run(EMPTY, states).checks) expect(c.state).toBe(SHIELD_STATE.UNAVAILABLE)
  })

  it('with an EMPTY sourceStates object, every check is unavailable (never no issue)', () => {
    for (const c of run(SOURCES, {}).checks) expect(c.state).toBe(SHIELD_STATE.UNAVAILABLE)
    for (const c of run(EMPTY, {}).checks) expect(c.state).toBe(SHIELD_STATE.UNAVAILABLE)
  })

  it('non-boolean flags are treated as failed, never as settled', () => {
    const c = get(CHECK.DUPLICATE_INVOICE_REFERENCES, SOURCES, withState({ supplierInvoices: { loading: 'no', error: undefined } }))
    expect(c.state).toBe(SHIELD_STATE.UNAVAILABLE)
  })
})

// ── 2 · Dependency isolation (perturbation-verified) ─────────────────────────

const stripVolatile = (c) => ({ ...c })

describe('dependency isolation — each check waits on exactly the sources that move it', () => {
  for (const id of CHECK_ORDER) {
    const baseline = stripVolatile(get(id))
    for (const dep of CHECK_DEPENDENCIES[id]) {
      it(`${id}: emptying DECLARED source ${dep} changes the result`, () => {
        expect(stripVolatile(get(id, emptied(dep)))).not.toEqual(baseline)
      })
    }
    for (const src of SHIELD_SOURCES.filter(s => !CHECK_DEPENDENCIES[id].includes(s))) {
      it(`${id}: emptying UNDECLARED source ${src} leaves the result unchanged`, () => {
        expect(stripVolatile(get(id, emptied(src)))).toEqual(baseline)
      })
      it(`${id}: a FAILED undeclared source ${src} does not block it`, () => {
        expect(stripVolatile(get(id, SOURCES, withState({ [src]: settled(false, true) })))).toEqual(baseline)
      })
      it(`${id}: a LOADING undeclared source ${src} does not block it`, () => {
        expect(stripVolatile(get(id, SOURCES, withState({ [src]: settled(true) })))).toEqual(baseline)
      })
    }
  }

  it('declared dependencies are exactly the approved sets', () => {
    expect(CHECK_DEPENDENCIES).toEqual({
      [CHECK.DUPLICATE_INVOICE_REFERENCES]: ['supplierInvoices'],
      [CHECK.INVOICE_INTEGRITY]:            ['supplierInvoices'],
      [CHECK.PO_OVER_INVOICING]:            ['purchaseOrders', 'supplierInvoices', 'variations'],
      [CHECK.COMMITMENT_STATE_CONFLICTS]:   ['purchaseOrders', 'progressClaims', 'supplierInvoices', 'variations'],
      [CHECK.FINANCIAL_EXCEPTIONS]:         ['supplierInvoices', 'supplierPayments', 'supplierCreditNotes', 'retentionReleases'],
    })
  })
})

// ── 3 · Check 1: potential duplicate supplier invoices ───────────────────────

describe('check 1 — potential duplicate supplier invoices', () => {
  const c = get(CHECK.DUPLICATE_INVOICE_REFERENCES)

  it('groups non-cancelled invoices by supplier identity + normalised reference', () => {
    expect(c.state).toBe(SHIELD_STATE.FINDING)
    expect(c.values).toMatchObject({ groupCount: 2, invoiceCount: 5, legacyGroupCount: 1, blankReferenceCount: 1, assessedCount: 11 })
    const groups = new Map()
    for (const r of c.evidence) groups.set(r.groupKey, [...(groups.get(r.groupKey) ?? []), r.id])
    expect([...groups.values()].map(g => g.sort())).toEqual([['inv1', 'inv3', 'inv5'], ['inv6', 'inv6b']])
    expect(c.headline).toMatch(/potential duplicates to review/)
    expect(c.headline).not.toMatch(/fraud|duplicate invoice detected/i)
  })

  it('evidence rows carry source ids, both references, status, date, recorded gross and the match basis', () => {
    const r = c.evidence.find(x => x.id === 'inv3')
    expect(r).toMatchObject({
      invoiceNumber: 'SI-0003', supplierInvoiceNumber: ' inv-100 ', supplierName: 'ACE CONCRETE', status: 'posted',
      statusLabel: 'Posted', invoiceDate: '2026-02-01', grossTotal: 330, legacyNameMatch: false, matchBasis: 'Supplier id',
    })
    const draft = c.evidence.find(x => x.id === 'inv5')
    expect(draft.statusLabel).toBe('Draft')
    const legacy = c.evidence.find(x => x.id === 'inv6b')
    expect(legacy).toMatchObject({ legacyNameMatch: true, matchBasis: 'Supplier name (legacy)', supplierId: null })
    expect(c.caveats.join(' ')).toMatch(/frozen supplier name/)
    const keys = c.evidenceColumns.map(col => col.key)
    expect(keys).toEqual(['supplierInvoiceNumber', 'supplierName', 'invoiceNumber', 'statusLabel', 'invoiceDate', 'grossTotal', 'matchBasis'])
  })

  it('a cancelled invoice never forms or joins a group', () => {
    expect(c.evidence.map(r => r.id)).not.toContain('inv12')
    const only = get(CHECK.DUPLICATE_INVOICE_REFERENCES, { ...EMPTY, supplierInvoices: [inv1, inv12] })
    expect(only.state).toBe(SHIELD_STATE.NO_ISSUE)
  })

  it('supplier identity: ids first — different ids are never combined because their names match', () => {
    const a = { ...inv1, id: 'a', supplierId: 'supA', supplierName: 'Same Name', supplierInvoiceNumber: 'X-1' }
    const b = { ...inv1, id: 'b', supplierId: 'supB', supplierName: 'Same Name', supplierInvoiceNumber: 'X-1' }
    expect(get(CHECK.DUPLICATE_INVOICE_REFERENCES, { ...EMPTY, supplierInvoices: [a, b] }).state).toBe(SHIELD_STATE.NO_ISSUE)
    const sameId = { ...b, supplierId: 'supA', supplierName: 'Different Display Name' }
    const found = get(CHECK.DUPLICATE_INVOICE_REFERENCES, { ...EMPTY, supplierInvoices: [a, sameId] })
    expect(found.state).toBe(SHIELD_STATE.FINDING)
    expect(found.values.legacyGroupCount).toBe(0)
  })

  it('supplier identity: a legacy null-id invoice is never combined with an id-bearing one', () => {
    const a = { ...inv1, id: 'a', supplierId: 'supA', supplierName: 'Ace Concrete', supplierInvoiceNumber: 'X-1' }
    const b = { ...inv1, id: 'b', supplierId: null, supplierName: 'Ace Concrete', supplierInvoiceNumber: 'X-1' }
    expect(get(CHECK.DUPLICATE_INVOICE_REFERENCES, { ...EMPTY, supplierInvoices: [a, b] }).state).toBe(SHIELD_STATE.NO_ISSUE)
    const b2 = { ...b, id: 'b2', supplierName: ' ace   concrete ' }
    const found = get(CHECK.DUPLICATE_INVOICE_REFERENCES, { ...EMPTY, supplierInvoices: [b, b2] })
    expect(found.state).toBe(SHIELD_STATE.FINDING)
    expect(found.values.legacyGroupCount).toBe(1)
  })

  it('references normalise exactly as duplicateInvoiceWarnings does (trim, lower-case, strip whitespace)', () => {
    const a = { ...inv1, id: 'a', supplierInvoiceNumber: ' INV 100 ' }
    const b = { ...inv1, id: 'b', supplierInvoiceNumber: 'inv100' }
    const d = { ...inv1, id: 'd', supplierInvoiceNumber: 'INV-100' } // the hyphen makes it a DIFFERENT reference
    const found = get(CHECK.DUPLICATE_INVOICE_REFERENCES, { ...EMPTY, supplierInvoices: [a, b, d] })
    expect(found.values).toMatchObject({ groupCount: 1, invoiceCount: 2 })
    expect(found.evidence.map(r => r.id).sort()).toEqual(['a', 'b'])
  })

  it('blank references are skipped and reported — all-blank is needs data (references missing), not no issue', () => {
    const blank = { ...inv1, id: 'x', supplierInvoiceNumber: '   ' }
    const r = get(CHECK.DUPLICATE_INVOICE_REFERENCES, { ...EMPTY, supplierInvoices: [blank, { ...blank, id: 'y', supplierInvoiceNumber: null }] })
    expect(r.state).toBe(SHIELD_STATE.NEEDS_DATA)
    expect(r.reason).toBe(NEEDS_DATA_REASON.REFERENCES_MISSING)
    expect(r.values).toMatchObject({ assessedCount: 0, blankReferenceCount: 2 })
    const mixed = get(CHECK.DUPLICATE_INVOICE_REFERENCES, { ...EMPTY, supplierInvoices: [blank, inv1] })
    expect(mixed.state).toBe(SHIELD_STATE.NO_ISSUE)
    expect(mixed.caveats.join(' ')).toMatch(/1 invoice has no supplier reference/)
  })

  it('a single invoice per reference is a genuine no issue naming what was compared', () => {
    const r = get(CHECK.DUPLICATE_INVOICE_REFERENCES, { ...EMPTY, supplierInvoices: [inv1, inv2, inv4] })
    expect(r.state).toBe(SHIELD_STATE.NO_ISSUE)
    expect(r.headline).toBe('No repeated supplier reference across 3 invoices')
    expect(r.evidence).toEqual([])
  })

  it('tolerates malformed legacy documents (null entries, missing fields)', () => {
    const r = get(CHECK.DUPLICATE_INVOICE_REFERENCES, { ...EMPTY, supplierInvoices: [null, {}, { id: 'z', status: 'posted' }, inv1] })
    expect(r.state).toBe(SHIELD_STATE.NO_ISSUE)
  })
})

// ── 4 · Check 2: supplier invoice integrity ──────────────────────────────────

describe('check 2 — supplier invoice integrity', () => {
  const c = get(CHECK.INVOICE_INTEGRITY)

  it('assesses only counting (posted / paid) invoices; drafts and approved are never integrity failures', () => {
    expect(c.values).toMatchObject({ assessedCount: 9, mismatchCount: 1, missingCostCodeCount: 1, malformedCount: 1, cleanCount: 6 })
    expect(c.evidence.map(r => r.invoiceId)).not.toContain('inv5') // the inconsistent DRAFT
    expect(c.evidence.map(r => r.invoiceId)).not.toContain('inv7') // approved, not counting
    expect(SI_COUNTING_STATUSES).toContain('posted')
  })

  it('a stored total that differs from its lines is a verified mismatch, compared in whole cents through invoiceTotals', () => {
    const r = c.evidence.find(x => x.id === 'inv9:totals')
    expect(r).toMatchObject({
      invoiceNumber: 'SI-0010', issue: INTEGRITY_ISSUE.TOTALS_MISMATCH, field: 'payableTotal', detail: 'payable total',
      stored: 20, fromLines: invoiceTotals(inv9.lineItems, inv9.retention).payableTotal, difference: 9,
    })
    expect(r.fromLines).toBe(11)
  })

  it('a counted line without a cost code is listed with its ex-GST amount', () => {
    const r = c.evidence.find(x => x.id === 'inv10:costcode')
    expect(r).toMatchObject({ invoiceNumber: 'SI-0011', issue: INTEGRITY_ISSUE.MISSING_COST_CODE, stored: 5, fromLines: null, difference: null })
    expect(r.detail).toBe('1 of 2 lines (ex-GST amount shown)')
  })

  it('a malformed record is insufficient data, never a mismatch — and alone it is needs data', () => {
    const r = c.evidence.find(x => x.id === 'inv11:malformed')
    expect(r).toMatchObject({ issue: INTEGRITY_ISSUE.MALFORMED, detail: 'no readable line items', stored: null })
    const only = get(CHECK.INVOICE_INTEGRITY, { ...EMPTY, supplierInvoices: [inv11] })
    expect(only.state).toBe(SHIELD_STATE.NEEDS_DATA)
    expect(only.reason).toBe(NEEDS_DATA_REASON.MALFORMED_RECORDS)
    expect(only.evidence).toHaveLength(1)
    const nonNumeric = { ...inv1, id: 'n', lineItems: [{ ...inv1.lineItems[0], amount: 'abc' }] }
    expect(get(CHECK.INVOICE_INTEGRITY, { ...EMPTY, supplierInvoices: [nonNumeric] }).evidence[0].detail).toBe('line 1 has no numeric amount')
    const missingHeader = { ...inv1, id: 'm', payableTotal: undefined }
    expect(get(CHECK.INVOICE_INTEGRITY, { ...EMPTY, supplierInvoices: [missingHeader] }).evidence[0].detail).toBe('stored payable total is missing')
  })

  it('retention is reconciled through the same composition: a consistent retained invoice is clean', () => {
    const r = get(CHECK.INVOICE_INTEGRITY, { ...EMPTY, supplierInvoices: [inv2] })
    expect(r.state).toBe(SHIELD_STATE.NO_ISSUE)
    expect(inv2).toMatchObject({ retention: 10, retentionGst: 1, retentionTotal: 11, net: 40, payableGst: 4, payableTotal: 44 })
    const wrongRetention = { ...inv2, id: 'wr', retentionTotal: 12 }
    const f = get(CHECK.INVOICE_INTEGRITY, { ...EMPTY, supplierInvoices: [wrongRetention] })
    expect(f.state).toBe(SHIELD_STATE.FINDING)
    expect(f.evidence[0]).toMatchObject({ field: 'retentionTotal', stored: 12, fromLines: 11, difference: 1 })
  })

  it('cent rounding: a sub-cent float difference is NOT a mismatch; one whole cent is', () => {
    const float = { ...inv1, id: 'f', subtotal: 1000.004 }
    expect(get(CHECK.INVOICE_INTEGRITY, { ...EMPTY, supplierInvoices: [float] }).state).toBe(SHIELD_STATE.NO_ISSUE)
    const cent = { ...inv1, id: 'c', subtotal: 1000.01 }
    const f = get(CHECK.INVOICE_INTEGRITY, { ...EMPTY, supplierInvoices: [cent] })
    expect(f.state).toBe(SHIELD_STATE.FINDING)
    expect(f.evidence[0].difference).toBe(0.01)
  })

  it('per-line GST is never re-derived from the amount (the create path\'s unrounded-GST artefact is not a finding)', () => {
    // 1234.045 entered: amount 1234.05, gstAmount from the unrounded figure 123.40 (not 123.41).
    const line = { poLineIndex: 0, costCodeId: 'cc1', costCodeName: 'x', description: 'x', amount: 1234.05, taxCode: 'gst', gstAmount: 123.4 }
    const t = invoiceTotals([line], 0)
    const legit = { ...inv1, id: 'g', lineItems: [line], ...t }
    expect(get(CHECK.INVOICE_INTEGRITY, { ...EMPTY, supplierInvoices: [legit] }).state).toBe(SHIELD_STATE.NO_ISSUE)
  })

  it('no posted invoices is needs data, never no issue', () => {
    const r = get(CHECK.INVOICE_INTEGRITY, { ...EMPTY, supplierInvoices: [inv5, inv7] })
    expect(r.state).toBe(SHIELD_STATE.NEEDS_DATA)
    expect(r.reason).toBe(NEEDS_DATA_REASON.NO_RECORDS)
  })

  it('a clean set is a genuine no issue that names what was checked', () => {
    const r = get(CHECK.INVOICE_INTEGRITY, { ...EMPTY, supplierInvoices: [inv1, inv2, inv3] })
    expect(r.state).toBe(SHIELD_STATE.NO_ISSUE)
    expect(r.headline).toBe('All 3 posted invoices reconcile to their lines, with a cost code on every line')
  })
})

// ── 5 · Check 3: purchase order over-invoicing exposure ──────────────────────

describe('check 3 — purchase order over-invoicing exposure', () => {
  const c = get(CHECK.PO_OVER_INVOICING)
  const byLine = postedInvoicedByPoLine(SOURCES.supplierInvoices)
  const byPo = postedInvoicedByPo(SOURCES.supplierInvoices)

  it('line and PO-level excess are the existing selectors compared with the PO values', () => {
    expect(c.state).toBe(SHIELD_STATE.FINDING)
    const rows = c.evidence.filter(r => r.poId === 'po1')
    expect(rows.map(r => r.id)).toEqual(['po1:line:0', 'po1:line:1', 'po1:po'])
    expect(rows[0]).toMatchObject({ level: 'line', poLineIndex: 0, poAmount: 800, invoiced: byLine.po1[0], excess: 300, levelLabel: 'Line 1' })
    expect(rows[1]).toMatchObject({ level: 'line', poLineIndex: 1, poAmount: 400, invoiced: byLine.po1[1], excess: 300 })
    expect(rows[2]).toMatchObject({ level: 'po', poAmount: 1200, invoiced: byPo.po1, excess: 600, levelLabel: 'PO total' })
    expect(byLine.po1[0]).toBe(1100)
    expect(byPo.po1).toBe(1800)
  })

  it('reports line excess and PO-level excess as separate totals, never added together', () => {
    expect(c.values).toMatchObject({ poCount: 1, invoicedPoCount: 3, lineRowCount: 2, poRowCount: 1, lineExcessTotal: 600, poExcessTotal: 600 })
    expect(c.values).not.toHaveProperty('totalExcess')
    expect(c.caveats.join(' ')).toMatch(/must not be added together/)
  })

  it('approved supplier variations on the PO are context columns from the existing signed selector — never deducted', () => {
    const svs = SOURCES.variations.filter(v => v.variationType === 'supplier' && v.status === 'approved' && v.poId === 'po1')
    for (const r of c.evidence.filter(r => r.poId === 'po1')) {
      expect(r.approvedVariationCount).toBe(1)
      expect(r.approvedVariationsTotal).toBe(approvedSupplierVariationsTotal(svs))
      expect(r.approvedVariationsTotal).toBe(250)
      expect(r.excess).toBe(r.level === 'po' ? 600 : 300) // unchanged by the variation
    }
    // Without variations the rows are identical except the context columns.
    const without = get(CHECK.PO_OVER_INVOICING, emptied('variations'))
    const withoutContext = (r) => {
      const o = { ...r }
      delete o.approvedVariationCount
      delete o.approvedVariationsTotal
      return o
    }
    expect(without.evidence.map(withoutContext)).toEqual(c.evidence.map(withoutContext))
    expect(without.evidence[0]).toMatchObject({ approvedVariationCount: 0, approvedVariationsTotal: null })
    expect(c.caveats.join(' ')).toMatch(/never deducted/)
  })

  it('a submitted supplier variation and a client variation are never PO context', () => {
    const only = get(CHECK.PO_OVER_INVOICING, { ...SOURCES, variations: SOURCES.variations.filter(v => v.id !== 'v1') })
    expect(only.evidence[0]).toMatchObject({ approvedVariationCount: 0, approvedVariationsTotal: null })
  })

  it('a PO invoiced at or under its values is not listed — exact match is not excess; one cent over is', () => {
    expect(c.evidence.map(r => r.poId)).not.toContain('po5')
    expect(c.evidence.map(r => r.poId)).not.toContain('po2')
    const exact = { ...inv2, id: 'e', poId: 'po5', lineItems: [{ ...inv2.lineItems[0], amount: 100, gstAmount: 10 }], ...totals(100, 10) }
    expect(get(CHECK.PO_OVER_INVOICING, { ...EMPTY, purchaseOrders: SOURCES.purchaseOrders, supplierInvoices: [exact] }).state).toBe(SHIELD_STATE.NO_ISSUE)
    const cent = { ...exact, lineItems: [{ ...exact.lineItems[0], amount: 100.01 }] }
    const f = get(CHECK.PO_OVER_INVOICING, { ...EMPTY, purchaseOrders: SOURCES.purchaseOrders, supplierInvoices: [cent] })
    expect(f.state).toBe(SHIELD_STATE.FINDING)
    expect(f.evidence.map(r => [r.level, r.excess])).toEqual([['line', 0.01], ['po', 0.01]])
  })

  it('only posted invoices count — drafts, approved and cancelled move nothing', () => {
    const r = get(CHECK.PO_OVER_INVOICING, { ...EMPTY, purchaseOrders: SOURCES.purchaseOrders, supplierInvoices: [inv5, inv7, inv12] })
    expect(r.state).toBe(SHIELD_STATE.NEEDS_DATA)
    expect(r.reason).toBe(NEEDS_DATA_REASON.NO_RECORDS)
  })

  it('an invoice line pointing at a PO line index that does not exist is listed as excess against a zero value', () => {
    const ghost = { ...inv2, id: 'gh', poId: 'po5', lineItems: [{ ...inv2.lineItems[0], poLineIndex: 4 }] }
    const r = get(CHECK.PO_OVER_INVOICING, { ...EMPTY, purchaseOrders: SOURCES.purchaseOrders, supplierInvoices: [ghost] })
    const row = r.evidence.find(x => x.level === 'line')
    expect(row).toMatchObject({ poLineIndex: 4, poAmount: 0, invoiced: 50, excess: 50, levelLabel: 'Line 5 (not on PO)' })
  })

  it('a posted invoice whose PO is not in the project is reported as not comparable, not as clean', () => {
    const r = get(CHECK.PO_OVER_INVOICING, { ...EMPTY, purchaseOrders: [], supplierInvoices: [inv1] })
    expect(r.state).toBe(SHIELD_STATE.NO_ISSUE)
    expect(r.values.unresolvedPoCount).toBe(1)
    expect(r.caveats.join(' ')).toMatch(/could not be found in this project/)
  })

  it('is worded as exposure requiring human review, not an error', () => {
    expect(c.caveats.join(' ')).toMatch(/commercial exposure, not necessarily an error/)
    expect(c.caveats.join(' ')).toMatch(/credit note/)
  })
})

// ── 6 · Check 4: commitment records requiring reconciliation ─────────────────

describe('check 4 — commitment state conflicts', () => {
  const c = get(CHECK.COMMITMENT_STATE_CONFLICTS)

  it('finds exactly the approved conditions, one row per related record', () => {
    expect(c.state).toBe(SHIELD_STATE.FINDING)
    expect(c.values.byCondition).toEqual({
      [STATE_CONFLICT.UNCOMMITTED_PO_WITH_COST]:    2,
      [STATE_CONFLICT.CLOSED_PO_WITH_OPEN_CLAIM]:   1,
      [STATE_CONFLICT.MULTIPLE_OPEN_CLAIMS]:        2,
      [STATE_CONFLICT.MULTIPLE_INVOICES_PER_CLAIM]: 2,
      // E (ADR-55): the fixture's claims carry no line items, so no PO line is
      // recognised through both paths here — the dedicated test below builds one.
      [STATE_CONFLICT.MIXED_MODE_PO_LINE]:          0,
      // F (ADR-62): v5 is applied to po3 with a cost-code mismatch.
      [STATE_CONFLICT.VARIATION_NOT_INCORPORATED]:  1,
      // G (ADR-62): the fixture's claims carry no line items, so no recognised
      // claim sits on a PO line — the dedicated block below builds the cases.
      [STATE_CONFLICT.CLAIM_ABOVE_REVISED_LINE]:    0,
      // H (ADR-63): no claim line names a variation source here — the dedicated
      // block in tests/unit/newScopeClaims.test.js builds the cases.
      [STATE_CONFLICT.INVALID_CLAIM_SOURCE_LINE]:   0,
    })
    expect(c.values.conflictCount).toBe(8)
    expect(c.evidence).toHaveLength(8)
    expect(new Set(c.evidence.map(r => r.id)).size).toBe(8)
    expect(Object.keys(STATE_CONFLICT)).toHaveLength(8)
  })

  it('A · cancelled PO with a posted invoice and an approved claim', () => {
    const rows = c.evidence.filter(r => r.condition === STATE_CONFLICT.UNCOMMITTED_PO_WITH_COST)
    expect(rows.map(r => [r.poNumber, r.poStatusLabel, r.recordKind, r.recordNumber, r.recordStatusLabel, r.amount])).toEqual([
      ['PO-0002', 'Cancelled', 'invoice', 'SI-0006', 'Posted', 200],
      ['PO-0002', 'Cancelled', 'claim', 'PC-0002', 'Approved', 500],
    ])
    expect(rows.map(r => r.recordId)).toEqual(['inv6', 'cl2'])
  })

  it('A · a draft or pending-approval PO with counted cost is listed too; a sent PO is not', () => {
    const draftPo = { ...SOURCES.purchaseOrders[1], id: 'po2', status: 'draft' }
    const r = get(CHECK.COMMITMENT_STATE_CONFLICTS, { ...EMPTY, purchaseOrders: [draftPo], supplierInvoices: [inv6] })
    expect(r.evidence.map(x => [x.condition, x.poStatusLabel])).toEqual([[STATE_CONFLICT.UNCOMMITTED_PO_WITH_COST, 'Draft']])
    const sentPo = { ...draftPo, status: 'sent' }
    expect(get(CHECK.COMMITMENT_STATE_CONFLICTS, { ...EMPTY, purchaseOrders: [sentPo], supplierInvoices: [inv6] }).state).toBe(SHIELD_STATE.NO_ISSUE)
  })

  it('B · closed PO with an open (submitted) claim', () => {
    const rows = c.evidence.filter(r => r.condition === STATE_CONFLICT.CLOSED_PO_WITH_OPEN_CLAIM)
    expect(rows.map(r => [r.poNumber, r.poStatusLabel, r.recordNumber, r.recordStatusLabel, r.amount])).toEqual([
      ['PO-0003', 'Closed', 'PC-0003', 'Submitted', 100],
    ])
  })

  it('C · two open claims on one PO list both claims', () => {
    const rows = c.evidence.filter(r => r.condition === STATE_CONFLICT.MULTIPLE_OPEN_CLAIMS)
    expect(rows.map(r => [r.poNumber, r.recordNumber, r.recordStatusLabel]).sort()).toEqual([
      ['PO-0004', 'PC-0004', 'Draft'], ['PO-0004', 'PC-0005', 'Submitted'],
    ])
  })

  it('D · two non-cancelled invoices for one claim list both invoices, naming the claim', () => {
    const rows = c.evidence.filter(r => r.condition === STATE_CONFLICT.MULTIPLE_INVOICES_PER_CLAIM)
    expect(rows.map(r => [r.recordId, r.claimNumber, r.recordStatusLabel])).toEqual([
      ['inv7', 'PC-0001', 'Approved'], ['inv8', 'PC-0001', 'Approved'],
    ])
    expect(rows[0].recordNumber).toBe('SI-0008 (claim PC-0001)')
    const oneCancelled = { ...SOURCES, supplierInvoices: SOURCES.supplierInvoices.map(i => (i.id === 'inv8' ? { ...i, status: 'cancelled' } : i)) }
    expect(get(CHECK.COMMITMENT_STATE_CONFLICTS, oneCancelled).values.byCondition[STATE_CONFLICT.MULTIPLE_INVOICES_PER_CLAIM]).toBe(0)
  })

  it('rejected claims, cancelled invoices and committed POs raise nothing; the clean project is a genuine no issue', () => {
    const clean = {
      ...EMPTY,
      purchaseOrders: [SOURCES.purchaseOrders[0], SOURCES.purchaseOrders[4]],
      progressClaims: [SOURCES.progressClaims[0], SOURCES.progressClaims[5]],
      supplierInvoices: [inv1, inv2, inv7, inv12],
    }
    const r = get(CHECK.COMMITMENT_STATE_CONFLICTS, clean)
    expect(r.state).toBe(SHIELD_STATE.NO_ISSUE)
    expect(r.values.conflictCount).toBe(0)
  })

  it('a related record whose PO is missing from the project renders "Not found" rather than crashing', () => {
    const r = get(CHECK.COMMITMENT_STATE_CONFLICTS, { ...EMPTY, progressClaims: [SOURCES.progressClaims[3], SOURCES.progressClaims[4]] })
    expect(r.evidence.map(x => [x.condition, x.poStatusLabel, x.poNumber])).toEqual([
      [STATE_CONFLICT.MULTIPLE_OPEN_CLAIMS, 'Not found', 'PO-0004'],
      [STATE_CONFLICT.MULTIPLE_OPEN_CLAIMS, 'Not found', 'PO-0004'],
    ])
  })

  it('is labelled as records requiring reconciliation and infers no conduct', () => {
    expect(c.title).toBe('Commitment records requiring reconciliation')
    expect(c.caveats.join(' ')).toMatch(/not an inference of unauthorised conduct/)
    expect(c.caveats.join(' ') + c.explanation).not.toMatch(/illegal|fraud/i)
  })
})

// ── 7 · Check 5: existing financial exceptions ───────────────────────────────

describe('check 4 — condition E: a PO line recognised through BOTH paths (ADR-55)', () => {
  // One PO line carrying a POSTED direct invoice (200) AND an approved claim
  // (300) that no posted claim-sourced invoice has superseded. Actual counts
  // both; the overlap listed is the smaller of the two — a bound, never a fix.
  const po = { id: 'poE', poNumber: 'PO-0009', status: 'sent', subtotal: 800, lineItems: [
    { costCodeId: 'cc1', costCodeName: '03-100 — Concrete', description: 'Slab', lineTotal: 800 },
  ] }
  const approvedClaim = { id: 'clE', claimNumber: 'PC-0009', status: 'approved', poId: 'poE', poNumber: 'PO-0009', approvedSubtotal: 300,
    lineItems: [{ poLineIndex: 0, costCodeId: 'cc1', approvedThisPeriod: 300 }] }
  const directInv = inv({
    id: 'invE', invoiceNumber: 'SI-0090', supplierInvoiceNumber: 'E-1', status: 'posted',
    supplierId: 'sup1', supplierName: 'Ace Concrete', poId: 'poE', poNumber: 'PO-0009', invoiceDate: '2026-03-01',
    lineItems: [{ poLineIndex: 0, costCodeId: 'cc1', costCodeName: '03-100 — Concrete', description: 'Slab', amount: 200, taxCode: 'gst', gstAmount: 20 }],
    ...totals(200, 20),
  })
  const sources = { ...EMPTY, purchaseOrders: [po], progressClaims: [approvedClaim], supplierInvoices: [directInv] }

  it('lists the line once, with the overlap as its amount and both source records named', () => {
    const c = get(CHECK.COMMITMENT_STATE_CONFLICTS, sources)
    expect(c.state).toBe(SHIELD_STATE.FINDING)
    expect(c.values.byCondition[STATE_CONFLICT.MIXED_MODE_PO_LINE]).toBe(1)
    const [row] = c.evidence.filter(r => r.condition === STATE_CONFLICT.MIXED_MODE_PO_LINE)
    expect(row.poNumber).toBe('PO-0009')
    expect(row.recordKind).toBe('poLine')
    expect(row.amount).toBe(200)
    expect(row.directInvoiced).toBe(200)
    expect(row.recognisedClaims).toBe(300)
    expect(row.recordNumber).toContain('SI-0090')
    expect(row.recordNumber).toContain('PC-0009')
    expect(row.recordStatusLabel).toBe('Both counted in Actual')
    expect(c.headline).toContain('po line counted through both')
  })

  it('is NOT a finding once the claim is superseded by its posted claim-sourced invoice, or while the direct invoice is a draft', () => {
    const claimInv = inv({ ...directInv, id: 'invF', invoiceNumber: 'SI-0091', supplierInvoiceNumber: 'F-1', source: 'progress_claim',
      progressClaimId: 'clE', claimNumber: 'PC-0009', lineItems: [{ poLineIndex: 0, costCodeId: 'cc1', costCodeName: '03-100 — Concrete', description: 'Slab', amount: 300, taxCode: 'gst', gstAmount: 30 }], ...totals(300, 30) })
    // Superseded claim + posted direct invoice: the claim no longer counts, so no overlap.
    const superseded = get(CHECK.COMMITMENT_STATE_CONFLICTS, { ...sources, supplierInvoices: [directInv, claimInv] })
    expect(superseded.values.byCondition[STATE_CONFLICT.MIXED_MODE_PO_LINE]).toBe(0)
    // Direct invoice still a draft: nothing is counted yet.
    const drafted = get(CHECK.COMMITMENT_STATE_CONFLICTS, { ...sources, supplierInvoices: [{ ...directInv, status: 'draft' }] })
    expect(drafted.values.byCondition[STATE_CONFLICT.MIXED_MODE_PO_LINE]).toBe(0)
    expect(drafted.state).toBe(SHIELD_STATE.NO_ISSUE)
    // Different lines: no overlap.
    const otherLine = get(CHECK.COMMITMENT_STATE_CONFLICTS, { ...sources,
      purchaseOrders: [{ ...po, lineItems: [...po.lineItems, { costCodeId: 'cc2', costCodeName: 'x', description: 'y', lineTotal: 100 }] }],
      supplierInvoices: [{ ...directInv, lineItems: [{ ...directInv.lineItems[0], poLineIndex: 1 }] }] })
    expect(otherLine.values.byCondition[STATE_CONFLICT.MIXED_MODE_PO_LINE]).toBe(0)
  })

  it('a cancelled PO with the same records is condition A for both and condition E for the line', () => {
    const c = get(CHECK.COMMITMENT_STATE_CONFLICTS, { ...sources, purchaseOrders: [{ ...po, status: 'cancelled' }] })
    expect(c.values.byCondition[STATE_CONFLICT.UNCOMMITTED_PO_WITH_COST]).toBe(2)
    expect(c.values.byCondition[STATE_CONFLICT.MIXED_MODE_PO_LINE]).toBe(1)
  })
})

describe('check 5 — existing financial exceptions (reuse only)', () => {
  const c = get(CHECK.FINANCIAL_EXCEPTIONS)
  const { supplierInvoices, supplierPayments, supplierCreditNotes, retentionReleases } = SOURCES
  const releasedMap = releasedByInvoiceId(retentionReleases)

  it('rows ARE the existing selectors\' outputs, one row per underlying exception, with the originating module', () => {
    expect(c.state).toBe(SHIELD_STATE.FINDING)
    const allocation = allocationExceptions(supplierPayments, supplierInvoices)
    const credit = creditNoteExceptions(supplierCreditNotes, supplierInvoices)
    const release = releaseExceptions(retentionReleases, supplierInvoices)
    const overReleased = overReleasedRows(retentionInvoiceRows(supplierInvoices, retentionReleases))
    const payables = payablesSummary(supplierInvoices, supplierPayments, supplierCreditNotes, releasedMap)
    const over = overReconciledPayableRows(payables.rows)

    expect(c.values.byKind).toEqual({
      [EXCEPTION_KIND.ALLOCATION]: allocation.length,
      [EXCEPTION_KIND.CREDIT_NOTE]: credit.length,
      [EXCEPTION_KIND.RELEASE]: release.length,
      [EXCEPTION_KIND.OVER_RELEASED]: overReleased.length,
      [EXCEPTION_KIND.OVER_RECONCILED]: over.length,
    })
    expect(c.values.byKind).toEqual({ allocation: 2, credit_note: 1, release: 1, over_released: 1, over_reconciled: 1 })
    expect(c.values.exceptionCount).toBe(6)
    expect(c.evidence).toHaveLength(6)
    expect(new Set(c.evidence.map(r => r.id)).size).toBe(6)

    const rows = (kind) => c.evidence.filter(r => r.kind === kind)
    expect(rows(EXCEPTION_KIND.ALLOCATION).map(r => [r.recordNumber, r.invoiceNumber, r.amount, r.reason]))
      .toEqual(allocation.map(e => [e.paymentNumber, e.invoiceNumber, e.allocatedAmount, e.reason]))
    expect(rows(EXCEPTION_KIND.CREDIT_NOTE).map(r => [r.recordNumber, r.invoiceNumber, r.amount, r.reason]))
      .toEqual(credit.map(e => [e.creditNumber, e.invoiceNumber, e.grossTotal, e.reason]))
    expect(rows(EXCEPTION_KIND.RELEASE).map(r => [r.recordNumber, r.invoiceNumber, r.amount, r.reason]))
      .toEqual(release.map(e => [e.releaseNumber, e.invoiceNumber, e.releaseTotal, e.reason]))
    expect(rows(EXCEPTION_KIND.OVER_RELEASED).map(r => [r.recordNumber, r.amount, r.reference]))
      .toEqual(overReleased.map(r => [r.invoiceNumber, r.releasedTotal, r.retentionTotal]))
    expect(rows(EXCEPTION_KIND.OVER_RECONCILED).map(r => [r.recordNumber, r.amount, r.reference]))
      .toEqual(over.map(r => [r.invoiceNumber, r.remaining, r.payableTotal]))
    expect(c.values.overReconciledTotal).toBe(payables.overReconciled)
    for (const r of c.evidence) expect(r.moduleLabel).toMatch(/^(Supplier Payments|Supplier Invoices · Credit Notes|Retention)$/)
  })

  it('pins the fixture: the over-reconciled balance includes the VALID credit and the two allocations; the invalid credit reduces nothing', () => {
    const over = c.evidence.find(r => r.kind === EXCEPTION_KIND.OVER_RECONCILED)
    // inv1: basis 1100; settled = 1500 (sp1) + 10 (sp2, still cash against this id) + 110 (cn1) = 1620 → remaining −520.
    expect(over).toMatchObject({ invoiceNumber: 'SI-0001', amount: -520, reference: 1100 })
    const creditRow = c.evidence.find(r => r.kind === EXCEPTION_KIND.CREDIT_NOTE)
    expect(creditRow.recordNumber).toBe('SCN-0002')
    expect(creditRow.reason).toMatch(/withholds retention/)
    // inv2 (its target) is NOT over-reconciled: the invalid credit did not reduce the liability.
    expect(c.evidence.filter(r => r.kind === EXCEPTION_KIND.OVER_RECONCILED).map(r => r.invoiceNumber)).toEqual(['SI-0001'])
    const released = c.evidence.find(r => r.kind === EXCEPTION_KIND.OVER_RELEASED)
    expect(released).toMatchObject({ invoiceNumber: 'SI-0002', amount: 16.5, reference: 11 })
  })

  it('a voided payment, credit or release removes its exception at the next evaluation (no reversal record)', () => {
    const voided = {
      ...SOURCES,
      supplierPayments: SOURCES.supplierPayments.map(p => (p.id === 'sp2' || p.id === 'sp3' ? { ...p, status: 'void' } : p)),
      supplierCreditNotes: SOURCES.supplierCreditNotes.map(n => (n.id === 'cn2' ? { ...n, status: 'void' } : n)),
      retentionReleases: SOURCES.retentionReleases.map(r => (r.id === 'rr2' || r.id === 'rr3' ? { ...r, status: 'void' } : r)),
    }
    const r = get(CHECK.FINANCIAL_EXCEPTIONS, voided)
    expect(r.values.byKind).toEqual({ allocation: 0, credit_note: 0, release: 0, over_released: 0, over_reconciled: 1 })
  })

  it('no posted payables records is needs data; posted records with no exception is a genuine no issue', () => {
    const none = get(CHECK.FINANCIAL_EXCEPTIONS, { ...EMPTY, supplierInvoices: [inv5], supplierPayments: [SOURCES.supplierPayments[3]] })
    expect(none.state).toBe(SHIELD_STATE.NEEDS_DATA)
    expect(none.reason).toBe(NEEDS_DATA_REASON.NO_RECORDS)
    const clean = get(CHECK.FINANCIAL_EXCEPTIONS, { ...EMPTY, supplierInvoices: [inv1, inv2], supplierPayments: [
      { id: 'ok', paymentNumber: 'SP-0009', status: 'posted', supplierId: 'sup1', supplierName: 'Ace Concrete', amount: 100, allocatedTotal: 100, unallocatedAmount: 0,
        allocations: [{ supplierInvoiceId: 'inv1', invoiceNumber: 'SI-0001', allocatedAmount: 100 }] },
    ] })
    expect(clean.state).toBe(SHIELD_STATE.NO_ISSUE)
    expect(clean.values).toMatchObject({ exceptionCount: 0, postedInvoiceCount: 2, postedPaymentCount: 1 })
  })

  it('explains that nothing is reversed, clamped or reassigned', () => {
    expect(c.caveats.join(' ')).toMatch(/Nothing is reversed, clamped or reassigned/)
    expect(c.caveats.join(' ')).toMatch(/no exception is counted twice/)
  })
})

// ── 8 · Financial consistency with the rest of the app ───────────────────────

describe('financial consistency — SHIELD changes nothing it reads', () => {
  it('the Dashboard snapshot for the same records is byte-identical before and after evaluateShield', () => {
    const snapSources = { ...SOURCES, budgetLines: [{ id: 'b', costCodeId: 'cc1', budgeted: 100 }], forecastLines: [], baseline: { originalContractValue: 1 } }
    const states = Object.fromEntries(SNAPSHOT_SOURCES.map(s => [s, settled()]))
    const before = JSON.stringify(projectSnapshot({ sources: snapSources, sourceStates: states, currencyCode: 'AUD' }))
    run(snapSources, withState({}))
    const after = JSON.stringify(projectSnapshot({ sources: snapSources, sourceStates: states, currencyCode: 'AUD' }))
    expect(after).toBe(before)
  })

  it('evaluateShield is deterministic for the same inputs', () => {
    expect(JSON.stringify(run())).toBe(JSON.stringify(run()))
  })

  it('every money value in every evidence row is a number rounded to cents or null', () => {
    for (const c of run().checks) {
      for (const col of c.evidenceColumns.filter(col => col.kind === 'money')) {
        for (const r of c.evidence) {
          const v = r[col.key]
          if (v === null || v === undefined) continue
          expect(typeof v, `${c.id}.${col.key}`).toBe('number')
          expect(Math.round(v * 100) / 100, `${c.id}.${col.key}`).toBe(v)
        }
      }
    }
  })

  it('every evidence row carries a unique id and the source record numbers it rests on', () => {
    for (const c of run().checks) {
      const ids = c.evidence.map(r => r.id)
      expect(new Set(ids).size, c.id).toBe(ids.length)
      for (const r of c.evidence) {
        expect(typeof r.id, c.id).toBe('string')
        const numbered = r.invoiceNumber || r.poNumber || r.recordNumber
        expect(numbered, `${c.id}:${r.id}`).toBeTruthy()
      }
      for (const col of c.evidenceColumns) expect(c.evidence.every(r => col.key in r), `${c.id}.${col.key}`).toBe(true)
    }
  })

  it('the engine has no score, severity, threshold, trend, prediction or AI, and no Firebase or write', () => {
    const src = stripComments(read('lib/shield.js'))
    expect(src).not.toMatch(/\b(score|severity|weight|threshold|trend|predict|forecastRisk|riskRating)\w*\b/i)
    expect(src).not.toMatch(/from 'firebase|onSnapshot|setDoc|updateDoc|addDoc|runTransaction|deleteDoc/)
    expect(src).not.toMatch(/Date\.now|new Date\(/)
    expect(src).not.toMatch(/from '\.\/(pulse|pulseAttention|forecast|margin|cashFlow)'/)
  })

  it('the engine does not duplicate a financial formula: no GST rate, no multiplication of money', () => {
    const src = stripComments(read('lib/shield.js'))
    expect(src).not.toMatch(/GST_RATE|\* 0\.1|\* GST/)
    expect(src).not.toMatch(/gstForLine|claimTotals|poTotals|creditNoteTotals|maturedCommittedByCostCode/)
  })
})

// ── 9 · Page wiring and roles (source structure — ADR-26) ────────────────────

describe('ProjectShield page — role gate, subscriptions, isolation, no writes', () => {
  const code = stripComments(read('pages/project/ProjectShield.jsx'))
  const cardCode = stripComments(read('pages/project/shield/ShieldCheckCard.jsx'))
  const pointer = stripComments(read('pages/Shield.jsx'))
  const wrapper = code.slice(code.indexOf('export default function ProjectShield'), code.indexOf('function StateCount'))
  const workspace = code.slice(code.indexOf('function ShieldWorkspace'))

  it('the financial-role gate is the wrapper; the workspace that mounts the subscriptions renders only behind it', () => {
    expect(wrapper).toContain('const { profile, profileLoading } = useProfile()')
    expect(wrapper).toContain('if (profileLoading) {')
    expect(wrapper).toContain('if (!isFinancialRole(profile?.role)) {')
    expect(wrapper).toContain('<ShieldWorkspace projectId={projectId} currencyCode={currencyCode} />')
    expect(wrapper).not.toMatch(/use(PurchaseOrders|ProgressClaims|SupplierInvoices|SupplierCreditNotes|SupplierPayments|RetentionReleases|Variations)\(/)
    expect(wrapper).toMatch(/Company Admin, Project Manager and QS/)
    expect(FINANCIAL_ROLES).toEqual(['company_admin', 'project_manager', 'qs'])
  })

  it('the workspace opens exactly the seven approved subscriptions, each once, through existing hooks', () => {
    const calls = workspace.match(/= use(PurchaseOrders|ProgressClaims|SupplierInvoices|SupplierCreditNotes|SupplierPayments|RetentionReleases|Variations)\(projectId\)/g)
    expect(calls).toHaveLength(7)
    expect(new Set(calls).size).toBe(7)
    expect(code).not.toMatch(/use(BudgetLines|ForecastLines|ProjectCommercial|ProjectActivities|CostCodes|Contacts|PulseAcknowledgements)\(/)
    for (const h of ['usePurchaseOrders', 'useProgressClaims', 'useSupplierInvoices', 'useSupplierCreditNotes', 'useSupplierPayments', 'useRetentionReleases', 'useVariations']) {
      expect(code).toContain(`import { ${h} } from '../../hooks/${h}'`)
    }
  })

  it('every source\'s loading AND error flag reaches evaluateShield in the snapshot shape', () => {
    for (const s of SHIELD_SOURCES) {
      expect(workspace).toMatch(new RegExp(`${s}:\\s*\\{ loading: ${s}Loading,\\s*error: ${s}Error \\}`))
    }
    expect(workspace).toContain('evaluateShield({')
  })

  it('no write path: no write callback consumed, no Firebase import, no transaction, no persistence', () => {
    for (const f of [code, cardCode, pointer]) {
      expect(f).not.toMatch(/from 'firebase/)
      expect(f).not.toMatch(/\b(create|update|upsert|cancel|post|void|approve|submit|issue|award|acknowledge|withdraw|save|delete)[A-Z]\w*\b/)
      expect(f).not.toMatch(/runTransaction|setDoc|updateDoc|addDoc|localStorage|sessionStorage/)
    }
    const lib = stripComments(read('lib/shield.js'))
    expect(lib).not.toMatch(/from 'firebase|from '\.\.\/hooks/)
  })

  it('currency comes from the outlet context (the project\'s resolved currency) — nothing hard-coded, never summed across projects', () => {
    expect(wrapper).toContain('const { projectId, currencyCode } = useOutletContext()')
    for (const f of [code, cardCode, pointer]) expect(f).not.toMatch(/'AUD'|'\$'|en-AU/)
    expect(cardCode).toContain('formatCurrency(value, currencyCode, { precise: true })')
    expect(code).not.toMatch(/useProjects\(|projects\.map|portfolio/i)
  })

  it('the project outlet is keyed by project, so a switch remounts SHIELD (ADR-44) and hooks keep keyed snapshots (ADR-41)', () => {
    expect(read('layouts/ProjectDetailLayout.jsx')).toContain('<Outlet key={projectId}')
    for (const h of ['usePurchaseOrders', 'useProgressClaims', 'useSupplierInvoices', 'useSupplierCreditNotes', 'useSupplierPayments', 'useRetentionReleases', 'useVariations']) {
      const hook = read(`hooks/${h}.jsx`)
      expect(hook, h).toMatch(/settled \? snap\./)
      expect(hook, h).toMatch(/targetKey !== null && !settled/)
    }
  })

  it('the page and card compute no figure: a role predicate only from the domain modules, no arithmetic on values', () => {
    expect(code).toContain("import { isFinancialRole } from '../../lib/margin'")
    expect(code).not.toMatch(/from '\.\.\/\.\.\/lib\/(forecast|supplierPayments|supplierInvoices|purchaseOrders|progressClaims|variations|retention|payments|projectSnapshot|pulse)'/)
    expect(cardCode).toContain("import { formatIsoDate } from '../../../lib/projectTimeline'")
    expect(cardCode).not.toMatch(/from '\.\.\/\.\.\/\.\.\/lib\/(margin|forecast|supplierPayments|supplierInvoices|variations|retention|payments|projectSnapshot|pulse)'/)
    for (const f of [code, cardCode]) expect(f).not.toMatch(/\.reduce\(|toFixed\(/)
    expect(code).toContain("from '../../lib/shield'")
  })

  it('the five states render distinctly, and unavailable / loading never show figures or evidence', () => {
    for (const s of ['FINDING', 'NEEDS_DATA', 'UNAVAILABLE', 'NO_ISSUE', 'LOADING']) {
      expect(cardCode).toContain(`[SHIELD_STATE.${s}]:`)
      expect(code).toContain(`[SHIELD_STATE.${s}]:`)
    }
    expect(cardCode).toContain('Could not load: {failedLabel(check.failedSources)}. This check was not assessed.')
    expect(cardCode).toContain("{loading && <p className=\"m-0 mt-1 text-[12.5px] text-brand-muted\">Waiting for records…</p>}")
    expect(cardCode).toContain('{!loading && !unavailable && (')
    expect(code).toContain('unavailable is never reported as no issue')
  })

  it('evidence: five-row preview with Show all, source-record heading, scrolling table, 44px targets, semantic headings', () => {
    expect(cardCode).toContain('const EVIDENCE_PREVIEW = 5')
    expect(cardCode).toContain("{showAll ? 'Show fewer' : `Show all ${rows.length}`}")
    expect(cardCode).toContain('Source records · {rows.length}')
    expect(cardCode).toContain('<div className="overflow-x-auto rounded-lg border border-brand-border">')
    expect(cardCode).toMatch(/<table className="w-full min-w-\[\d+px\]/)
    expect(cardCode).toContain('scope="col"')
    expect((cardCode.match(/min-h-\[44px\]/g) ?? []).length).toBeGreaterThanOrEqual(2)
    expect(cardCode).toContain('<h3 className="m-0 text-[14px] font-bold text-brand-text">{check.title}</h3>')
    expect(code).toContain('<h2 className="m-0 text-[15px] font-bold text-brand-text">{MODULE_NAMES.shield}</h2>')
    expect(code).not.toContain('<h1')
  })

  it('branding: SHIELD tile with the shared luminous dot beside its pause control, module tokens only, no score ring, chart, AI or Coming Soon', () => {
    expect(code).toContain('<ModuleTile module="shield" beat paused={beatPaused} />')
    expect(code).toContain('<BeatToggle paused={beatPaused} onToggle={() => setBeatPaused(p => !p)} subject="glow animation" />')
    // Pause state lives in the heading, never in the workspace that owns the subscriptions.
    const heading = code.slice(code.indexOf('function ShieldHeading'), code.indexOf('function ShieldWorkspace'))
    expect(heading).toContain('const [beatPaused, setBeatPaused] = useState(false)')
    expect(workspace).not.toMatch(/useState|beatPaused|BeatToggle/)
    // The animation is CSS-only, decorative, and never a monitoring claim.
    expect(code).not.toMatch(/setInterval|setTimeout|requestAnimationFrame|<canvas|animate-/)
    expect(code).not.toMatch(/\bLIVE\b|real-time|realtime|background monitoring/i)
    expect(pointer).not.toMatch(/\bbeat\b|BeatToggle|animate/)
    for (const f of [code, cardCode, pointer]) {
      expect(f).not.toMatch(/#[0-9a-fA-F]{3,6}\b/)
      expect(f).not.toMatch(/style=\{\{/)
      expect(f).not.toMatch(/Coming Soon|recharts|<canvas|health score|score ring|risk rating|\bAI\b/i)
    }
    expect(code).toContain("import { MODULE_NAMES } from '../../lib/moduleBranding'")
    expect(MODULE_NAMES.shield).toBe('Constrapp SHIELD™')
    expect(cardCode).not.toContain('brand-shield') // cyan is a brand mark, never a status colour
  })

  it('the route and tab exist, the tab sits immediately after PULSE with the static mark, and the hidden top-level route is a pointer with no subscription', () => {
    const app = read('App.jsx')
    expect(app).toContain('<Route path="shield" element={<ProjectShield />} />')
    expect(app).toContain("import ProjectShield from './pages/project/ProjectShield'")
    expect(app).toContain('<Route path="shield"         element={<Shield />} />')
    expect(PROJECT_TABS[1]).toEqual({ to: 'pulse', label: 'PULSE', mark: 'pulse' })
    expect(PROJECT_TABS[2]).toEqual({ to: 'shield', label: 'SHIELD', mark: 'shield' })
    expect(read('lib/nav.js')).not.toMatch(/to:\s*'\/shield'/)
    expect(pointer).toContain('to="/projects"')
    expect(pointer).not.toMatch(/from '\.\.\/hooks\/|onSnapshot|useOutletContext/)
    expect(pointer).not.toMatch(/safety|HSEQ|hazard|incident/i)
  })

  it('the restricted view says what is restricted and why, without opening a subscription', () => {
    expect(wrapper).toContain('SHIELD checks are restricted')
    expect(wrapper).toContain('Firestore')
  })
})

// ── 8 · ADR-62 (M3-B1): applied supplier variations in checks 3 and 4 ────────
//
// Check 3 compares posted invoicing against the REVISED PO line value (original
// + applied approved supplier-variation amounts on that line — the exact ceiling
// Remaining Committed nets); unapplied variations stay context. Check 4 gains
// condition F: an applied variation line that could not be incorporated.

const APPLIED = { commitmentAppliedAt: { seconds: 1, nanoseconds: 0 }, commitmentAppliedBy: 'u_qs' }
const appliedSv = (id, poId, poNumber, lines, over = {}) => ({
  id, variationNumber: `SV-${id}`, variationType: 'supplier', status: 'approved', poId, poNumber,
  approvedSubtotal: lines.reduce((s, l) => s + l.approvedAmount, 0), lineItems: lines, ...APPLIED, ...over,
})

describe('check 3 — the revised contractual ceiling (ADR-62)', () => {
  // po1: line 0 = 800 (posted 1100), line 1 = 400 (posted 700), subtotal 1200 (posted 1800).
  const svLine0 = appliedSv('a1', 'po1', 'PO-0001', [{ costCodeId: 'cc1', costCodeName: '03-100 — Concrete', poLineIndex: 0, approvedAmount: 300 }])
  const sources = { ...SOURCES, variations: [...SOURCES.variations, svLine0] }
  const c = get(CHECK.PO_OVER_INVOICING, sources)

  it('an applied variation on a line raises that line\'s ceiling: line 0 is no longer over-invoiced, line 1 still is, and the PO total compares against the revised subtotal', () => {
    const rows = c.evidence.filter(r => r.poId === 'po1')
    expect(rows.map(r => r.id)).toEqual(['po1:line:1', 'po1:po'])
    expect(rows[0]).toMatchObject({ level: 'line', poLineIndex: 1, originalAmount: 400, appliedAdjustment: 0, poAmount: 400, invoiced: 700, excess: 300 })
    expect(rows[1]).toMatchObject({ level: 'po', originalAmount: 1200, appliedAdjustment: 300, poAmount: 1500, invoiced: 1800, excess: 300 })
    expect(c.values).toMatchObject({ lineExcessTotal: 300, poExcessTotal: 300 })
  })

  it('the context columns distinguish approved from applied, and the applied amount equals the shared adjustment map', () => {
    const adj = appliedSupplierVariationAdjustments(sources.variations, sources.purchaseOrders)
    expect(adj.byPoLine.po1).toEqual({ 0: 300 })
    for (const r of c.evidence.filter(r => r.poId === 'po1')) {
      expect(r.approvedVariationCount).toBe(2)   // v1 (unapplied) + a1 (applied)
      expect(r.appliedVariationCount).toBe(1)
    }
    expect(c.caveats.join(' ')).toMatch(/APPLIED to the PO commitment are already inside the revised PO value/)
  })

  it('an UNAPPLIED approved variation changes no ceiling — the pre-ADR-62 rows are unchanged', () => {
    const unapplied = { ...svLine0, commitmentAppliedAt: undefined, commitmentAppliedBy: undefined }
    const r = get(CHECK.PO_OVER_INVOICING, { ...SOURCES, variations: [...SOURCES.variations, unapplied] })
    expect(r.evidence.filter(x => x.poId === 'po1').map(x => [x.id, x.poAmount, x.excess])).toEqual([
      ['po1:line:0', 800, 300], ['po1:line:1', 400, 300], ['po1:po', 1200, 600],
    ])
  })

  it('a NEGATIVE applied variation lowers the ceiling and the excess grows by exactly that amount', () => {
    const neg = appliedSv('n1', 'po1', 'PO-0001', [{ costCodeId: 'cc1', costCodeName: '03-100 — Concrete', poLineIndex: 0, approvedAmount: -100 }])
    const r = get(CHECK.PO_OVER_INVOICING, { ...SOURCES, variations: [neg] })
    expect(r.evidence.find(x => x.id === 'po1:line:0')).toMatchObject({ originalAmount: 800, appliedAdjustment: -100, poAmount: 700, excess: 400 })
    expect(r.evidence.find(x => x.id === 'po1:po')).toMatchObject({ poAmount: 1100, excess: 700 })
  })

  it('a variation applied to a cancelled PO, or with an invalid line, adjusts no ceiling', () => {
    const onCancelled = appliedSv('c1', 'po2', 'PO-0002', [{ costCodeId: 'cc3', poLineIndex: 0, approvedAmount: 999 }])
    const outOfRange = appliedSv('o1', 'po1', 'PO-0001', [{ costCodeId: 'cc1', poLineIndex: 7, approvedAmount: 999 }])
    const r = get(CHECK.PO_OVER_INVOICING, { ...SOURCES, variations: [onCancelled, outOfRange] })
    expect(r.evidence.filter(x => x.poId === 'po1').map(x => [x.id, x.poAmount, x.appliedAdjustment])).toEqual([
      ['po1:line:0', 800, 0], ['po1:line:1', 400, 0], ['po1:po', 1200, 0],
    ])
  })
})

describe('check 4 — condition F: applied supplier variation not incorporated (ADR-62)', () => {
  const c = get(CHECK.COMMITMENT_STATE_CONFLICTS)

  it('the fixture\'s cost-code mismatch is listed once with the variation, the PO, the issue and the amount', () => {
    const rows = c.evidence.filter(r => r.condition === STATE_CONFLICT.VARIATION_NOT_INCORPORATED)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      poNumber: 'PO-0003', poStatusLabel: 'Closed', recordKind: 'variation', recordId: 'v5', variationNumber: 'SV-0004',
      issue: 'cost_code_mismatch', recordStatusLabel: 'Cost code differs from the referenced PO line', amount: 40, poLineIndex: 0, lineIndex: 0,
    })
    expect(rows[0].recordNumber).toBe('SV-0004 PO line 1 — Cost code differs from the referenced PO line')
    expect(c.caveats.join(' ')).toMatch(/never counted against another PO line or cost code/)
  })

  it('an applied variation on a CANCELLED PO is listed (PO not committed) and the amount stays out of every ceiling', () => {
    const v = appliedSv('x1', 'po2', 'PO-0002', [{ costCodeId: 'cc3', poLineIndex: 0, approvedAmount: 150 }])
    const r = get(CHECK.COMMITMENT_STATE_CONFLICTS, { ...EMPTY, purchaseOrders: SOURCES.purchaseOrders, variations: [v] })
    expect(r.state).toBe(SHIELD_STATE.FINDING)
    expect(r.evidence.map(x => [x.condition, x.poNumber, x.poStatusLabel, x.issue, x.amount])).toEqual([
      [STATE_CONFLICT.VARIATION_NOT_INCORPORATED, 'PO-0002', 'Cancelled', 'po_not_committed', 150],
    ])
    expect(appliedSupplierVariationAdjustments([v], SOURCES.purchaseOrders).byPoLine).toEqual({})
  })

  it('an applied variation whose PO is missing is a FINDING even on an otherwise empty register — never "needs data"', () => {
    const v = appliedSv('m1', 'po_gone', 'PO-0099', [{ costCodeId: 'cc1', poLineIndex: 0, approvedAmount: 10 }])
    const r = get(CHECK.COMMITMENT_STATE_CONFLICTS, { ...EMPTY, variations: [v] })
    expect(r.state).toBe(SHIELD_STATE.FINDING)
    expect(r.evidence[0]).toMatchObject({ condition: STATE_CONFLICT.VARIATION_NOT_INCORPORATED, poStatusLabel: 'Not found', issue: 'po_missing', amount: 10 })
  })

  it('an out-of-range PO line index and a negative revised line value are both listed', () => {
    const outOfRange = appliedSv('o2', 'po1', 'PO-0001', [{ costCodeId: 'cc1', poLineIndex: 9, approvedAmount: 5 }])
    const tooNegative = appliedSv('n2', 'po1', 'PO-0001', [{ costCodeId: 'cc1', costCodeName: '03-100 — Concrete', poLineIndex: 0, approvedAmount: -900 }])
    const r = get(CHECK.COMMITMENT_STATE_CONFLICTS, { ...EMPTY, purchaseOrders: SOURCES.purchaseOrders, variations: [outOfRange, tooNegative] })
    const rows = r.evidence.filter(x => x.condition === STATE_CONFLICT.VARIATION_NOT_INCORPORATED)
    expect(rows.map(x => [x.issue, x.amount, x.recordKind])).toEqual([
      ['line_out_of_range', 5, 'variation'],
      ['negative_revised_line', -100, 'poLine'],   // 800 − 900
    ])
    // The −900 still nets the line (Remaining Committed floors at 0) — it is listed, not hidden or zeroed.
    expect(appliedSupplierVariationAdjustments([tooNegative], SOURCES.purchaseOrders).byPoLine.po1).toEqual({ 0: -900 })
  })

  it('a correctly incorporated applied variation raises no condition F', () => {
    const ok = appliedSv('k1', 'po1', 'PO-0001', [{ costCodeId: 'cc1', costCodeName: '03-100 — Concrete', poLineIndex: 0, approvedAmount: 120 }])
    const r = get(CHECK.COMMITMENT_STATE_CONFLICTS, { ...EMPTY, purchaseOrders: [SOURCES.purchaseOrders[0]], variations: [ok] })
    expect(r.state).toBe(SHIELD_STATE.NO_ISSUE)
    expect(r.explanation).toMatch(/every applied supplier variation is incorporated/)
  })
})

describe('check 4 — condition G: recognised claims above the revised PO line value (ADR-62 Correction D)', () => {
  // po4: one line cc5 of 1,000, sent. Claims and invoices built per case.
  const po4 = SOURCES.purchaseOrders[3]
  const claimOn = (id, approvedThisPeriod, over = {}) => ({
    id, claimNumber: `PC-${id}`, status: 'approved', poId: 'po4', poNumber: 'PO-0004', approvedSubtotal: approvedThisPeriod, claimedSubtotal: approvedThisPeriod,
    lineItems: [{ poLineIndex: 0, costCodeId: 'cc5', costCodeName: '05-100 — Roof', poLineTotal: 1000, previouslyApproved: 0, claimedToDate: approvedThisPeriod, claimedThisPeriod: approvedThisPeriod, approvedThisPeriod }],
    ...over,
  })
  const claimInvoice = (id, cl, amount) => ({
    id, invoiceNumber: `SI-${id}`, supplierInvoiceNumber: `X-${id}`, status: 'posted', source: 'progress_claim', poId: 'po4', poNumber: 'PO-0004', progressClaimId: cl.id, claimNumber: cl.claimNumber,
    supplierId: 'sup4', supplierName: 'Roof Co', currency: 'AUD', invoiceDate: '2026-01-10', dueDate: '2026-02-10',
    lineItems: [{ poLineIndex: 0, costCodeId: 'cc5', costCodeName: '05-100 — Roof', description: 'Roof', amount, taxCode: 'gst', gstAmount: amount / 10 }],
    ...totals(amount, amount / 10),
  })
  const g = (sources) => get(CHECK.COMMITMENT_STATE_CONFLICTS, { ...EMPTY, purchaseOrders: [po4], ...sources })
  const rowsG = (r) => r.evidence.filter(x => x.condition === STATE_CONFLICT.CLAIM_ABOVE_REVISED_LINE)

  it('a valid partial claim within the revised line raises nothing (no false positive); an approved claim exactly at the ceiling raises nothing', () => {
    expect(rowsG(g({ progressClaims: [claimOn('a', 400)] }))).toEqual([])
    expect(rowsG(g({ progressClaims: [claimOn('b', 1000)] }))).toEqual([])
    const plus = appliedSv('p', 'po4', 'PO-0004', [{ costCodeId: 'cc5', costCodeName: '05-100 — Roof', poLineIndex: 0, approvedAmount: 200 }])
    expect(rowsG(g({ progressClaims: [claimOn('c', 1200)], variations: [plus] }))).toEqual([])
  })

  it('a NEGATIVE applied variation that lowers the ceiling below what a claim already recognised is listed with the PO, cost code, revised value and the claim', () => {
    const neg = appliedSv('n', 'po4', 'PO-0004', [{ costCodeId: 'cc5', costCodeName: '05-100 — Roof', poLineIndex: 0, approvedAmount: -300 }])
    const r = g({ progressClaims: [claimOn('d', 900)], variations: [neg] })
    const rows = rowsG(r)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      poNumber: 'PO-0004', poStatusLabel: 'Sent', costCodeId: 'cc5', costCodeName: '05-100 — Roof', poLineIndex: 0,
      originalAmount: 1000, appliedAdjustment: -300, revisedLineValue: 700, recognisedClaims: 900, postedInvoiced: 0, recognised: 900, amount: 200,
      claimNumbers: ['PC-d'], invoiceNumbers: [], recordStatusLabel: 'Recognised above the line as reduced by a negative variation',
    })
    expect(r.state).toBe(SHIELD_STATE.FINDING)
    expect(r.caveats.join(' ')).toMatch(/a claim and its posted invoice are never both counted/)
  })

  it('a claim approved ABOVE the original line before the covering variation is applied is listed; applying the variation then clears it', () => {
    const before = g({ progressClaims: [claimOn('e', 1150)] })
    expect(rowsG(before)[0]).toMatchObject({ revisedLineValue: 1000, recognisedClaims: 1150, amount: 150, recordStatusLabel: 'Recognised above the revised line value' })
    const cover = appliedSv('v', 'po4', 'PO-0004', [{ costCodeId: 'cc5', costCodeName: '05-100 — Roof', poLineIndex: 0, approvedAmount: 150 }])
    expect(rowsG(g({ progressClaims: [claimOn('e', 1150)], variations: [cover] }))).toEqual([])
  })

  it('the claim → invoice hand-over never double counts: posting the claim\'s invoice leaves the same single row with the recognition moved from the claim column to the invoice column', () => {
    const neg = appliedSv('n', 'po4', 'PO-0004', [{ costCodeId: 'cc5', costCodeName: '05-100 — Roof', poLineIndex: 0, approvedAmount: -300 }])
    const cl = claimOn('f', 900)
    const claimed = rowsG(g({ progressClaims: [cl], variations: [neg] }))
    const invoiced = rowsG(g({ progressClaims: [cl], supplierInvoices: [claimInvoice('f', cl, 900)], variations: [neg] }))
    expect(claimed[0]).toMatchObject({ recognisedClaims: 900, postedInvoiced: 0, recognised: 900, amount: 200 })
    // Once the claim is superseded by its posted invoice, the recognition is invoice-only: that overrun is check 3's, not G's.
    expect(invoiced).toEqual([])
    const check3 = get(CHECK.PO_OVER_INVOICING, { ...EMPTY, purchaseOrders: [po4], progressClaims: [cl], supplierInvoices: [claimInvoice('f', cl, 900)], variations: [neg] })
    expect(check3.evidence.find(x => x.id === 'po4:line:0')).toMatchObject({ poAmount: 700, invoiced: 900, excess: 200 })
  })

  it('a partly invoiced claim counts claim and invoice recognition ONCE each (ADR-55 nets) — the excess is recognised − revised', () => {
    const cl1 = claimOn('h1', 500)                       // superseded by its posted invoice below
    const cl2 = claimOn('h2', 500, { id: 'h2' })          // approved, awaiting invoice
    const r = rowsG(g({ progressClaims: [cl1, cl2], supplierInvoices: [claimInvoice('h1', cl1, 500)], variations: [appliedSv('m', 'po4', 'PO-0004', [{ costCodeId: 'cc5', costCodeName: '05-100 — Roof', poLineIndex: 0, approvedAmount: -200 }])] }))
    expect(r[0]).toMatchObject({ recognisedClaims: 500, postedInvoiced: 500, recognised: 1000, revisedLineValue: 800, amount: 200, claimNumbers: ['PC-h2'], invoiceNumbers: ['SI-h1'] })
  })

  it('an invoice-only overrun (no approved claim on the line) is check 3\'s and never condition G; a loading or failed variations read makes the check unavailable, never a zero adjustment', () => {
    const direct = { ...claimInvoice('d1', { id: 'none', claimNumber: '' }, 1200), source: 'direct_po', progressClaimId: null, claimNumber: null }
    expect(rowsG(g({ supplierInvoices: [direct] }))).toEqual([])
    expect(get(CHECK.COMMITMENT_STATE_CONFLICTS, SOURCES, withState({ variations: settled(false, true) })).state).toBe(SHIELD_STATE.UNAVAILABLE)
    expect(get(CHECK.COMMITMENT_STATE_CONFLICTS, SOURCES, withState({ variations: settled(true) })).state).toBe(SHIELD_STATE.LOADING)
  })
})
